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
const { ensureDir: fsEnsureDir, emptyDir: fsEmptyDir } = require('fs-extra');
// ou import x as y

import unzip from 'unzipper';

import { getHashFetchPath } from './host';
import ExpoRetry from './expoRetry';
import Contracts from '@parity/shared/lib/contracts';
import { sha3 } from '@parity/api/lib/util/sha3';
import { bytesToHex } from '@parity/api/lib/util/format';

const fsExists = util.promisify(fs.stat);
const fsStat = util.promisify(fs.stat);
const fsRename = util.promisify(fs.rename);
const fsReadFile = util.promisify(fs.readFile);
const fsUnlink = util.promisify(fs.unlink);
const fsReaddir = util.promisify(fs.readdir);
const fsRmdir = util.promisify(fs.rmdir);
const httpsGet = util.promisify(https.get);

// ExpoRetry-related
function registerFailedAttemptAndThrow (hash, url, e) {
  ExpoRetry.get().registerFailedAttempt(hash, url);
  throw e;
}

function checkHashMatch (hash, path) {
  return fsReadFile(path).then(content => {
    if (sha3(content) !== `0x${hash}`) { throw new Error(`Hashes don't match: expected 0x${hash}, got ${sha3(content)}`); }
  });
}

function unzipTo (zipPath, extractPath) {
  return new Promise((resolve, reject) => {
    const unzipParser = unzip.Extract({ path: extractPath });

    fs.createReadStream(zipPath).pipe(unzipParser);

    unzipParser.on('error', function (e) {
      reject(e);
    });

    unzipParser.on('close', resolve);
  });
}

const MAX_DOWNLOADED_FILE_SIZE = 10485760; // 20MB

function download (url, destinationPath) {
  // Will replace any existing file
  const file = fs.createWriteStream(destinationPath);

  return httpsGet(url).then(response => new Promise((resolve, reject) => {
    var size = 0;

    response.on('data', function (data) {
      size += data.length;

      if (size > MAX_DOWNLOADED_FILE_SIZE) {
        response.destroy();
        response.unpipe(file);
        fsUnlink(destinationPath);
        reject(`File download aborted: exceeded maximum size of ${MAX_DOWNLOADED_FILE_SIZE} bytes`);
      }
    });

    response.pipe(file);

    file.on('finish', function () {
      file.close(() => resolve());
    });
  }));
}

function hashDownload (hash, url, zip = false) {
  const tempFilename = `${hash}.part`;
  const tempPath = path.join(getHashFetchPath(), 'partial', tempFilename); // todo make sure filename cannot be '../' or something

  const finalPath = path.join(getHashFetchPath(), 'files', hash);

  return download(url, tempPath)
      .then(() => checkHashMatch(hash, tempPath).catch(e => registerFailedAttemptAndThrow(hash, url, e)))
      .then(() => { // Hashes match
        if (!zip) {
          return fsRename(tempPath, finalPath);
        } else {
          const extractPath = path.join(getHashFetchPath(), 'partial-extract', tempFilename);

          return unzipTo(tempPath, extractPath)
            .then(() => fsUnlink(tempPath))
            .then(() => { // todo call a functional function (needs to be inside unzip)
              // npm debug todo
              return fsReaddir(extractPath)
                  .then(filenames => // Gather info about files
                    Promise.all(filenames.map(filename => {
                      const filePath = path.join(extractPath, filename);

                      return fsStat(filePath).then(stat => ({ isDirectory: stat.isDirectory(), filePath, filename }));
                    }))
                  )
                  .then(filenames => {
                    if (filenames.length === 1 && filenames[0].isDirectory) {
                      // Zip file with a root folder
                      const rootFolderPath = filenames[0].filePath;

                      return fsRename(rootFolderPath, finalPath)
                        .then(() => fsRmdir(extractPath));
                    } else {
                      // Zip file without root folder
                      return fsRename(extractPath, finalPath);
                    }
                  });
            });
        }
      });
}

// mettre dans la classe ou non?
function queryRegistryAndDownload (api, hash, expected) {
  const { githubHint } = Contracts.get(api);

  return githubHint.getEntry(`0x${hash}`).then(([slug, commitBytes, author]) => {
    const commit = bytesToHex(commitBytes);

    if (!slug) {
      if (commit === '0x0000000000000000000000000000000000000000' && author === '0x0000000000000000000000000000000000000000') {
        throw new Error(`No GitHub Hint entry found.`);
      } else {
        throw new Error(`GitHub Hint entry has empty slug.`);
      }
    }

    let url;
    let zip;

    if (commit === '0x0000000000000000000000000000000000000000') { // The slug is the URL to a file
      if (!slug.toLowerCase().startsWith('http')) { throw new Error(`GitHub Hint URL ${slug} isn't HTTP/HTTPS.`); }
      url = slug;
      zip = false;
    } else if (commit === '0x0000000000000000000000000000000000000001') { // The slug is the URL to a dapp zip file
      if (!slug.toLowerCase().startsWith('http')) { throw new Error(`GitHub Hint URL ${slug} isn't HTTP/HTTPS.`); }
      url = slug;
      zip = true;
    } else { // The slug is the `owner/repo` of a dapp stored in GitHub
      url = `https://codeload.github.com/${slug}/zip/${commit.substr(2)}`;
      zip = true;
    }

    if (ExpoRetry.get().canAttemptDownload(hash, url) === false) {
      throw new Error(`Previous attempt at downloading ${hash} from ${url} failed; retry delay time not yet elapsed.`);
    }

    return hashDownload(hash, url, zip);
  });
}

// @todo confirm with tomek
function ensureMatchExpected (hash, filePath, expected) {
  return fsStat(filePath).then(stat => {
    if (stat.isDirectory() && expected === 'file') {
      throw new Error(`Expected ${hash} to be a file; got a folder (dapp).`);
    } else if (!stat.isDirectory() && expected === 'dapp') {
      throw new Error(`Expected ${hash} to be a dapp; got a file.`);
    }
  });
}

export default class HashFetch {
  static instance = null;
  initialize = null;
  promises = {}; // Unsettled or resolved promises

  static get () {
    if (!HashFetch.instance) {
      HashFetch.instance = new HashFetch();
    }

    return HashFetch.instance;
  }

  constructor () {
    this.initialize = this._initialize();
  }

  _initialize () {
    const hashFetchPath = getHashFetchPath();

    return fsEnsureDir(hashFetchPath).then(() =>
      Promise.all([
        fsEnsureDir(path.join(hashFetchPath, 'files')),
        fsEmptyDir(path.join(hashFetchPath, 'partial')),
        fsEmptyDir(path.join(hashFetchPath, 'partial-extract')),
        ExpoRetry.get().load()
      ]));
  }

  // @TODO save api in instance?
  // Returns a Promise that resolves with the path to the file or directory
  fetch (api, hash, expected) { // expected is either 'file' or 'dapp'
    this.initialize.then(() => {
      const filePath = path.join(getHashFetchPath(), 'files', hash);

      if (!(hash in this.promises)) {
        this.promises[hash] = fsExists(filePath)
          .catch(() => queryRegistryAndDownload(api, hash, expected))
          .then(() => ensureMatchExpected(hash, filePath, expected))
          .then(() => filePath)
          .catch(e => { delete this.promises[hash]; throw e; }); // Don't prevent retries
      }
      return this.promises[hash];
    });
  }
}
