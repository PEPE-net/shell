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

const { readJson: fsReadJson, writeJson: fsWriteJson } = window.require('fs-extra');
const fsExists = util.promisify(fs.stat);

// Handle exponential retry for failed download attempts
export default class ExpoRetry {
  static instance = null;

  // We store the URL to allow GH Hint URL updates for a given hash
  // to take effect immediately, and to disregard past failed attempts at
  // getting this file from other URLs.
  failHistory = {}; // { [`${hash}:${url}`]: {attempts: [{timestamp: _}, ...] } }

  // If true, failHistory was updated and needs to be written to disk
  needWrite = false;
  writeQueue = Promise.resolve();

  static get () {
    if (!ExpoRetry.instance) {
      ExpoRetry.instance = new ExpoRetry();
    }

    return ExpoRetry.instance;
  }

  _getFilePath () {
    return path.join(getHashFetchPath(), 'fail_history.json');
  }

  _getId (hash, url) {
    return `${hash}:${url}`;
  }

  load () {
    const filePath = this._getFilePath();

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
        .catch(() => fsWriteJson(filePath, {}));
  }

  canAttemptDownload (hash, url) {
    const id = this._getId(hash, url);

    // Never tried downloading the file
    if (!(id in this.failHistory) || !this.failHistory[id].attempts.length) {
      return true;
    }

    // Already failed at downloading the file: check if we can retry now
    // Delay starts at 30 seconds, max delay is 23 days
    const retriesCount = this.failHistory[id].attempts.length - 1;
    const latestAttemptDate = this.failHistory[id].attempts.slice(-1).timestamp;
    const earliestNextAttemptDate = latestAttemptDate + Math.pow(2, Math.min(16, retriesCount)) * 30000;

    if (Date.now() > earliestNextAttemptDate) {
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
      if (this.needWrite) {
        // Skip subsequent promises, considering we are writing the latest value
        this.needWrite = false;
        return fsWriteJson(this._getFilePath(), this.failHistory);
      }
    });
  }
}
