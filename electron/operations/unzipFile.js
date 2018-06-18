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

// Prompts "save as"...
// const { download } = require('electron-dl');

// Lets renderer process requests file downloads from Electron

// const path = require('path');
// const https = require('https');
// const fs = require('fs');

const util = require('util');

const extract = require('extract-zip');
const unzip = util.promisify(extract);

module.exports = (event, data) => {
  const { filepath, dir, filename } = data;

  console.log('unzip operation');
  return new Promise((resolve, reject) => { if (!filepath || !dir) { console.log('rejecting..'); reject(`unzipFile Invalid filepath (${filepath}) or directory (${dir})`); } else { resolve(); } }).then(() =>
    unzip(filepath, { dir, filename })).then(() => {
      console.log('unzip opration sending success');
      event.sender.send(`unzip-file-success-${filename}`);
    })
    .catch(e => {
      console.log('unzip operation sending error');
      event.sender.send(`unzip-file-error-${filename}`, e);
    });
};
