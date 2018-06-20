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
const { readJson: fsReadJson } = window.require('fs-extra');
const util = window.require('util');
const path = window.require('path');

import { getHashFetchPath } from './host';

const fsWriteFile = util.promisify(fs.writeFile);
const fsExists = util.promisify(fs.stat);

// Handle exponential retry for failed download attempts
export default class ExpoRetry {
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
        .then(() =>
          fsReadJson(filePath)
            .catch(e => {
              console.error(`Couldn't parse JSON for ExpoRetry file ${filePath}`, e);
              return {};
            })
        )
        .then(failHistory => {
          this.failHistory = failHistory;
        })
        .catch(() => fsWriteFile(filePath, '{}'));
  }

  _getId (hash, url) {
    return `${hash}:${url}`;
  }

  canAttemptDownload (hash, url) {
    const id = this._getId(hash, url);

    // Never tried downloading the file
    if (!(id in this.failHistory) || !this.failHistory[id].attempts.length) {
      return true;
    }

    // Already failed at downloading the file: check if we can retry now
    const attemptsCount = this.failHistory[id].attempts.length;
    const latestAttemptDate = this.failHistory[id].attempts.slice(-1).timestamp;

    if (Date.now() > latestAttemptDate + Math.pow(2, Math.max(16, attemptsCount)) * 3000) { // Start at 30sec, limit to 22 days max
      return true;
    }

    return false;
  }

  registerFailedAttempt (hash, url) {
    const id = this._getId(hash, url);

    this.failHistory[id] = this.failHistory[id] || { attempts: [] };
    this.failHistory[id].attempts.push({ timestamp: Date.now() });

    // Once the ongoing write is finished, write anew with the updated contents
    this.needWrite = true;
    this.queue = this.queue.then(() => {
      // Write once (the latest contents) even if there are stacked pending promises
      if (this.needWrite) {
        this.needWrite = false;
        return fsWriteFile(this.getFilePath(), JSON.stringify(this.failHistory));
      }
    });
  }
}
