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
import extract from 'extract-zip';
const { ipcRenderer } = window.require('electron');

const fsExists = util.promisify(fs.stat);
const fsRename = util.promisify(fs.rename);
const fsReadFile = util.promisify(fs.readFile);
const fsUnlink = util.promisify(fs.unlink);
const unzip = util.promisify(extract);

function checkHashMatch (hash, path) {
  return fsReadFile(path).then(content => {
    if (sha3(content) !== `0x${hash}`) { throw new Error(`Hashes don't match: expected 0x${hash}, got ${sha3(content)}`); }
  });
}

function queryRegistryAndDownload (api, hash) { // todo check expected ici
  const { githubHint } = Contracts.get(api);

  return githubHint.getEntry(`0x${hash}`).then(([slug, commit, author]) => {
    if (commit.every(x => x === 0)) { // @todo convert from bytes
      // The repo-slug is the URL to a file
      // @todo check is it starts with http ?
      return downloadUrl(hash, slug);
    } else if (commit.slice(-1).every(x => x === 0) && commit[commit.length - 1] === 1) {
      // The reposlug is the URL to a zip file with a dapp
      return downloadUrl(hash, slug);
    } else {
      // Dapp stored in GitHub

      // format!("https://codeload.github.com/{}/{}/zip/{}", self.account, self.repo, self.commit.to_hex())
      // todo commit needs to be converted to hex
      return downloadUrl(hash, `https://codeload.github.com/${slug}/zip/${commit}`);
    }
  });
}

function download (url, { directory, filename }) {
  return new Promise((resolve, reject) => {
    ipcRenderer.send('asynchronous-message', 'download-file', { url, directory, filename });

    ipcRenderer.once(`download-file-success-${filename}`, (sender, p) => {
      resolve(p);
    });

    ipcRenderer.once(`download-file-error-${filename}`, (sender, p) => {
      reject(p);
    });
  });
}

function downloadUrl (hash, url, zip = false) {
  const tempFilename = `${hash}.part`;

  return download(url, {
    directory: getHashFetchPath(),
    filename: `${hash}.part` // todo make sure filename cannot be '../' or something
  }) // todo error handling (can be upstream)
      .then(() => checkHashMatch(hash, path.join(getHashFetchPath(), tempFilename))) // @TODO DELETE .PART FILE AND USE BLACKLIST IF FAIL
      .then(() => {
        if (zip) { // @todo unzipping needs to be moved to operations/downloadFile
          return unzip(path.join(getHashFetchPath(), tempFilename), { dir: path.join(getHashFetchPath(), tempFilename) }).then(() => fsUnlink(path.join(getHashFetchPath(), tempFilename)));
        }
      })
      .then(() => fsRename(path.join(getHashFetchPath(), tempFilename), path.join(getHashFetchPath(), hash)));
}

const promises = {};

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
