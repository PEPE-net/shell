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
const https = window.require('https');

import unzip from 'unzipper';

import { getHashFetchPath } from './host';

import Contracts from '@parity/shared/lib/contracts';
import { sha3 } from '@parity/api/lib/util/sha3';
import { bytesToHex } from '@parity/api/lib/util/format';

const fsExists = util.promisify(fs.stat);
const fsRename = util.promisify(fs.rename);
const fsWriteFile = util.promisify(fs.writeFile);
const fsReadFile = util.promisify(fs.readFile);
const fsUnlink = util.promisify(fs.unlink);
const fsReaddir = util.promisify(fs.readdir);
const fsRmdir = util.promisify(fs.rmdir);

export class ExpoRetry {
  static instance = null;
  needWrite = false;
  writeQueue = Promise.resolve();
  failHistory = {}; // { "hash:url": {attempts: [{timestamp: _}] } }

  static get () {
    if (!ExpoRetry.instance) {
      ExpoRetry.instance = new ExpoRetry();
    }

    return ExpoRetry.instance;
  }

  getFilePath () {
    return path.join(getHashFetchPath(), 'fail_history.json');
  }

  load () { // = () { ?
    const filePath = this.getFilePath();

    return fsExists(filePath)
        .then(() => fsReadFile(filePath))
        .then(content => {
          try {
            this.failHistory = JSON.parse(content);
          } catch (e) {
            console.error(`Couldn't parse JSON for ExpoRetry file ${filePath}`, e);
            return {};
          }
        })
        .catch(() => fsWriteFile(filePath, '{}'));
  }

  _getId (hash, url) {
    return `${hash}:${url}`;
  }

  canAttemptDownload (hash, url) { // return bool
    const id = this._getId(hash, url);

        // Never tried downloading the file
    if (!(id in this.failHistory) || !this.failHistory[id].attempts.length) {
      return true;
    }

    const attemptsCount = this.failHistory[id].attempts.length;
    const latestAttemptDate = this.failHistory[id].attempts.slice(-1).timestamp;

    if (Date.now() > latestAttemptDate + Math.pow(2, Math.max(16, attemptsCount)) * 30 * 1000) { // Start at 30sec, limit to 22 days max
      return true;
    }

    return false;
  }

  registerFailedAttempt (hash, url) {
    const id = this._getId(hash, url);

    this.failHistory[id] = this.failHistory[id] || { attempts: [] };
    this.failHistory[id].attempts.push({ timestamp: Date.now() });

    this.needWrite = true;
    this.queue = this.queue.then(() => {
      if (this.needWrite) {
        this.needWrite = false;
        return fsWriteFile(this.getFilePath(), JSON.stringify(this.failHistory));
      }
      // Skip intermediary promises in the chain
    }); // ou alors resolve avec un count (latestcount)
    // mais il faut toujours que je stocke quelque chose en plus (latestcount/needwrite)..hum
  }
}

function checkHashMatch (hash, path) {
  return fsReadFile(path).then(content => {
    if (sha3(content) !== `0x${hash}`) { throw new Error(`Hashes don't match: expected 0x${hash}, got ${sha3(content)}`); }
  });
}

function queryRegistryAndDownload (api, hash) { // todo check expected ici
  const { githubHint } = Contracts.get(api);

  return githubHint.getEntry(`0x${hash}`).then(([slug, commitBytes, author]) => {
    const commit = bytesToHex(commitBytes);

    console.log('SLUG COMMIT AUTHOR', slug, commit, author);

    if (!slug && commit === '0x0000000000000000000000000000000000000000' && author === '0x0000000000000000000000000000000000000000') {
      throw new Error(`No GitHub Hint entry found.`);
    }
    if (commit === '0x0000000000000000000000000000000000000000') {
      console.log('repo slug is url to a file..');
      // The repo-slug is the URL to a file
      // @todo check is it starts with http ?
      if (!slug) { throw new Error(`GitHub Hint entry has no URL.`); }
      if (ExpoRetry.get().canAttemptDownload(hash, slug) === false) {
        throw new Error('ExpoRetry rejected.');
      }
      return downloadUrl(hash, slug); // todo move cette fonction à la fin, comme ça on a if exporetry qu'une seule fois
    } else if (commit === '0x0000000000000000000000000000000000000001') {
      // The repo-slug is the URL to a zip file with a dapp
      console.log('zipdapp', slug);
      if (ExpoRetry.get().canAttemptDownload(hash, slug) === false) {
        throw new Error('ExpoRetry rejected.');
      }
      return downloadUrl(hash, slug, true);
    } else {
      // Dapp stored in GitHub
      const url = `https://codeload.github.com/${slug}/zip/${commit.substr(2)}`;

      console.log('Downloading dapp from GitHub', url);
      if (ExpoRetry.get().canAttemptDownload(hash, slug) === false) {
        throw new Error('ExpoRetry rejected.');
      }
      return downloadUrl(hash, url, true); // todo use object instead of true arg?
    }
  });
}

function download (url, { directory, filename }) {
  if (!url || !filename || !directory) {
    return Promise.reject(`download: Invalid url (${url}) or directory (${directory}) or filename (${filename})`);
  }

  const dest = path.join(directory, filename);

  return new Promise((resolve, reject) => {
    var file = fs.createWriteStream(dest);

    // todo disable cors
    https.get(url, function (response) {
      var size = 0;
      var maxSize = 1048576; // 2MB

      maxSize *= 10; // 20MB

      response.on('data', function (data) {
        size += data.length;

        if (size > maxSize) {
          console.log('Resource stream exceeded limit (' + size + ')');

          response.destroy(); // Abort the response (close and cleanup the stream)
          response.unpipe(file);
          fsUnlink(dest); // Delete the file we were downloading the data to
          reject('FILE IS TOO BIG');
        }
      });

      response.pipe(file);
      file.on('finish', function () {
        file.close(() => resolve());
      });
    });
  });
}

function unzip_ (zippath, opts) {
  return new Promise((resolve, reject) => {
    var unzipParser = unzip.Extract({ path: opts.dir });

    fs.createReadStream(zippath).pipe(unzipParser);
    unzipParser.on('error', function (err) {
      reject(err);
    });

    unzipParser.on('close', resolve);
  });
}

function downloadUrl (hash, url, zip = false) {
  const tempFilename = `${hash}.part`;
  // todo use const "tempPartPath"

  console.log('downloadUrl', tempFilename);
  return download(url, {
    directory: path.join(getHashFetchPath(), 'partial'),
    filename: tempFilename // todo make sure filename cannot be '../' or something
  }) // todo error handling (can be upstream)
      .then(() => checkHashMatch(hash, path.join(getHashFetchPath(), 'partial', tempFilename))) // @TODO DELETE .PART FILE AND USE BLACKLIST IF FAIL
      .then(() => {
        if (zip) {
          // todo use const "extractTempPath"
          return unzip_(path.join(getHashFetchPath(), 'partial', tempFilename), { dir: path.join(getHashFetchPath(), 'partial-extract', tempFilename) }) // todo dir should be containing dir ; function concatentes with filename
            .then(() => fsUnlink(path.join(getHashFetchPath(), 'partial', tempFilename))) // TODO même si fail
            .then(() => { // todo call a functional function (needs to be inside unzip)
              console.log('gonna readdir...');
              return fsReaddir(path.join(getHashFetchPath(), 'partial-extract', tempFilename))
                  .then(filenames => {
                    if (filenames.length === 1 && filenames[0] !== 'index.html') {
                      // We assume is inside a root folder in the archive
                      // @TODO quid si c'est un fichier? on sert le fichier/index.html, risque?
                      console.log('renaming..');
                      return fsRename(path.join(getHashFetchPath(), 'partial-extract', tempFilename, filenames[0]), path.join(getHashFetchPath(), 'files', hash))
                        .then(() => {
                          console.log('removing dir..');
                          return fsRmdir(path.join(getHashFetchPath(), 'partial-extract', tempFilename));
                        });
                    } else {
                      console.log('zip doesnt contain root folder');
                      fsRename(path.join(getHashFetchPath(), 'partial-extract', tempFilename), path.join(getHashFetchPath(), 'files', hash));
                    }
                  });
            });
        } else {
          return fsRename(path.join(getHashFetchPath(), 'partial', tempFilename), path.join(getHashFetchPath(), 'files', hash));
        }
      }); // ^ je peux avoir deux directories hashfetch/dapps et hashfetch/files aussi
}

const promises = {};

// Returns a Promise that resolves with the path to the file or directory
// @TODO use expected to make sure we don't get a dapp when fetching a file or vice versa
export default function hashFetch (api, hash, expected /* 'file' || 'dapp' */) {
  if (hash in promises) { return promises[hash]; }

  promises[hash] = fsExists(path.join(getHashFetchPath(), 'files', hash)) // todo either file or directory. BUT CHECK IF IT'S A DIRECTORY IF expected IS A DIRECTORY. IF THE DIRECTORY DOESN'T EXIST THEN WE ASSUME IT'S BEING UNPACKED.
      .catch(() => queryRegistryAndDownload(api, hash))
      .then(() => path.join(getHashFetchPath(), 'files', hash));

  return promises[hash];
}

// todo error handling, & doc if necessary
