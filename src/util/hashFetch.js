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
// const { download } = require('electron-dl');
// const { getHashFetchPath } = window.require('./host');

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

// import { https } from 'follow-redirects';

// const mainWindow = require('electron').BrowserWindow;

function checkHashMatch (hash, path) {
  return fsReadFile(path).then(content => {
    if (sha3(content) !== `0x${hash}`) { throw new Error(`Hashes don't match match: expected 0x${hash}, got ${sha3(content)}`); }
    // si hash mismatch, alors del file?
  });
}

function queryAndDownload (api, hash) { // todo check expected ici
  const { githubHint } = Contracts.get(api);

  return githubHint.getEntry(`0x${hash}`).then(([slug, commit, author]) => {
    console.log('RESULT OF GITHUBHINT', [slug, commit, author]);

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

// // mocking electron-dl @TODO @TEMP
// const mainWindow = 123;

// // NEED TO FOLLOW REDIRECTIONS IN ANY CASE
// function download (_, url, { directory, filename }) {
//   const dest = path.join(directory, filename);

//   return new Promise((resolve, reject) => {
//     var file = fs.createWriteStream(dest);

//     // todo disable cors
//     https.get(url, function (response) {
//       response.pipe(file);
//       file.on('finish', function () {
//         file.close(() => resolve());
//       });
//     });
//   });
// }

/*
REMPLACER DOWNLOAD PAR:
const downloadPromises = [];

ipcRenderer.on('file-download-success', (filename) => {

});

ipcRenderer.on('file-download-error', (filename) => {

});
// je sais pas ce que ipcrenderer retourne? undefined ou bien ce qui est retourné par callback,
*/

function download (url, { directory, filename }) {
  console.log('download', url);
  return new Promise((resolve, reject) => {
    ipcRenderer.send('asynchronous-message', 'download-file', { url, directory, filename });

    ipcRenderer.once(`download-file-success-${filename}`, (sender, p) => {
      console.log('SUCCESS !', p);
      resolve(p);
    });

    ipcRenderer.once(`download-file-error-${filename}`, (sender, p) => {
      console.log('ERROR !', p);
      reject(p);
    });
  });
}

function downloadUrl (hash, url, zip = false) {
  const tempFilename = `${hash}.part`;

  console.log('Requesting URL download: ', url);

  return download(url, {
    directory: getHashFetchPath(),
    filename: `${hash}.part` // todo make sure filename cannot be '../' or something
  }) // todo error handling (can be upstream)
      .then(() => checkHashMatch(hash, path.join(getHashFetchPath(), tempFilename)))
      .then(() => {
        if (zip) {
          return unzip(path.join(getHashFetchPath(), tempFilename), { dir: path.join(getHashFetchPath(), tempFilename) }).then(() => fsUnlink(path.join(getHashFetchPath(), tempFilename)));
        }
      })
      .then(() => fsRename(path.join(getHashFetchPath(), tempFilename), path.join(getHashFetchPath(), hash)));
  // avec filesize limit -- but is it really necessary given we only
  //
  //
  // WAAAAAAIT, dapp download needs to be a background electron process!!
  // can't be set here
  // otherwise it gets garbage collected
  //
  // do we want to interrupt the download if the user quits the page?
}

const promises = {};

// Returns a Promise that resolves with the path to the file or directory
// @TODO use expected to make sure we don't get a dapp when fetching a file or vice versa
export default function hashFetch (api, hash, expected /* 'file' || 'dapp' */) {
 //  if (hash !== 'fe26f6a19ea9393d69bc5d8c73c5072ccf126f51c10c135b42d6bf162d774fd9') { return Promise.resolve(); }

  if (hash in promises) { return promises[hash]; }

  console.log('hashfetch', hash); // @TODO ADD PROPER LOGGING TO SPOT RACE CONDITIONS ETC.
  promises[hash] = fsExists(path.join(getHashFetchPath(), hash)) // todo either file or directory. BUT CHECK IF IT'S A DIRECTORY IF expected IS A DIRECTORY. IF THE DIRECTORY DOESN'T EXIST THEN WE ASSUME IT'S BEING UNPACKED.
      .catch(() => (
        fsExists(path.join(getHashFetchPath(), `${hash}.part`))
          .then(() => console.log('UNIMPLEMENTED')) // check every second, or return the same promise
          .catch(() => queryAndDownload(api, hash)) // download
      ))
      .then(() => path.join(getHashFetchPath(), hash))
    .catch((e) => console.log('A HASHFETCH ERROR OCCURED', e)); // hashfetch an error occured e

  return promises[hash];
}

// todo error handling, & doc if necessary
