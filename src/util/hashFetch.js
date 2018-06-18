// Copyright 2015-2017 Parity Technologies (UK) Ltd.
// This file is part of Parity.

// Parity is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// Parity is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with Parity.  If not, see <http://www.gnu.org/licenses/>.

const fs = window.require('fs');
const util = window.require('util');
const path = window.require('path');

import { getHashFetchPath } from './host';

import Contracts from '@parity/shared/lib/contracts';
import { sha3 } from '@parity/api/lib/util/sha3';
import { bytesToHex } from '@parity/api/lib/util/format';
const { ipcRenderer } = window.require('electron');

const fsExists = util.promisify(fs.stat);
const fsRename = util.promisify(fs.rename);
const fsReadFile = util.promisify(fs.readFile);
const fsUnlink = util.promisify(fs.unlink);
const fsReaddir = util.promisify(fs.readdir);
const fsRmdir = util.promisify(fs.rmdir);

function checkHashMatch (hash, path) {
  return fsReadFile(path).then(content => {
    if (sha3(content) !== `0x${hash}`) { throw new Error(`Hashes don't match: expected 0x${hash}, got ${sha3(content)}`); }
  });
}

function queryRegistryAndDownload (api, hash) { // todo check expected ici
  const { githubHint } = Contracts.get(api);

  return githubHint.getEntry(`0x${hash}`).then(([slug, commit, author]) => {
    // TODO CONVERT COMMIT FROM BYTES
    if (!slug && commit.every(x => x === 0) && author === '0x0000000000000000000000000000000000000000') {
      throw new Error(`No GitHub Hint entry found.`);
    }

    // todo bytesToHex sur le slug et tester against 0x0000000000000000000000000000000000000000
    if (commit.every(x => x === 0)) { // @todo convert from bytes
      // The repo-slug is the URL to a file
      // @todo check is it starts with http ?
      if (!slug) { throw new Error(`GitHub Hint entry has no URL.`); }
      return downloadUrl(hash, slug);
    } else if (commit.slice(-1).every(x => x === 0) && commit[commit.length - 1] === 1) {
      // The reposlug is the URL to a zip file with a dapp
      console.log('zipdapp', slug);
      return downloadUrl(hash, slug, true);
    } else {
      // Dapp stored in GitHub
      commit = bytesToHex(commit).substr(2);
      console.log('stored in github', `https://codeload.github.com/${slug}/zip/${commit}`);
      // format!("https://codeload.github.com/{}/{}/zip/{}", self.account, self.repo, self.commit.to_hex())
      // todo commit needs to be converted to hex
      return downloadUrl(hash, `https://codeload.github.com/${slug}/zip/${commit}`, true); // todo use object instead of true arg?
    }
  });
}

function download (url, { directory, filename }) {
  return new Promise((resolve, reject) => {
    // actually TODO I think it's safe to download it in this file; remove ipc calls
    ipcRenderer.send('asynchronous-message', 'download-file', { url, directory, filename });

    ipcRenderer.once(`download-file-success-${filename}`, (sender, p) => {
      resolve(p);
    });

    ipcRenderer.once(`download-file-error-${filename}`, (sender, p) => {
      reject(p);
    });
  });
}

function unzip (filepath, { dir, filename }) {
  return new Promise((resolve, reject) => {
    // actually TODO I think it's safe to download it in this file; remove ipc calls
    // but unzip doesn't work on the frontend
    ipcRenderer.send('asynchronous-message', 'unzip-file', { filepath, dir, filename });

    ipcRenderer.once(`unzip-file-success-${filename}`, (sender, p) => {
      console.log('ipcrenderer resolved');
      resolve(p);
    });

    ipcRenderer.once(`unzip-file-error-${filename}`, (sender, p) => {
      console.log('ipcrenderer errored');
      reject(p);
    });
  });
}

function downloadUrl (hash, url, zip = false) {
  const tempFilename = `${hash}${zip ? '.zip' : ''}.part`;

  return download(url, {
    directory: getHashFetchPath(),
    filename: tempFilename // todo make sure filename cannot be '../' or something
  }) // todo error handling (can be upstream)
      .then(() => checkHashMatch(hash, path.join(getHashFetchPath(), tempFilename))) // @TODO DELETE .PART FILE AND USE BLACKLIST IF FAIL
      .then(() => {
        if (zip) { // @todo unzipping needs to be moved to operations/downloadFile
          const tempFolderName = `${hash}.part`;

          return unzip(path.join(getHashFetchPath(), tempFilename), { dir: path.join(getHashFetchPath(), tempFolderName), filename: tempFolderName }) // todo dir should be containing dir ; function concatentes with filename
            .then(() => fsUnlink(path.join(getHashFetchPath(), tempFilename)))
            .then(() => {
              return fsReaddir(path.join(getHashFetchPath(), tempFolderName))
                  .then(filenames => {
                    if (filenames.length === 1 && filenames[0] !== 'index.html') {
                      // We assume is inside a root folder in the archive
                      // @TODO quid si c'est un fichier? on sert le fichier/index.html, risque?
                      return fsRename(path.join(getHashFetchPath(), tempFolderName, filenames[0]), path.join(getHashFetchPath(), hash))
                        .then(() => fsRmdir(path.join(getHashFetchPath(), tempFolderName)));
                    } else {
                      fsRename(path.join(getHashFetchPath(), tempFolderName), path.join(getHashFetchPath(), tempFilename));
                    }
                  });
            });
        } else {
          return fsRename(path.join(getHashFetchPath(), tempFilename), path.join(getHashFetchPath(), hash));
        }
      }); // ^ je peux avoir deux directories hashfetch/dapps et hashfetch/files aussi
}

// todo promise needs to be kept if we go back and come again, cf watching for part?
const promises = {}; // never gets killed, ye?

// Returns a Promise that resolves with the path to the file or directory
// @TODO use expected to make sure we don't get a dapp when fetching a file or vice versa
export default function hashFetch (api, hash, expected /* 'file' || 'dapp' */) {
  if (hash in promises) { return promises[hash]; }

  promises[hash] = fsExists(path.join(getHashFetchPath(), hash)) // todo either file or directory. BUT CHECK IF IT'S A DIRECTORY IF expected IS A DIRECTORY. IF THE DIRECTORY DOESN'T EXIST THEN WE ASSUME IT'S BEING UNPACKED.
      .catch(() => queryRegistryAndDownload(api, hash))
      .then(() => path.join(getHashFetchPath(), hash));

  return promises[hash];
}

// todo error handling, & doc if necessary
