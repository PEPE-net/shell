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

const { download } = require('electron-dl');

// Lets renderer process requests file downloads from Electron

module.exports = (event, data) => {
  const { url, directory, filename } = data;

  console.log('downloadFile...', url, directory, filename);

  return new Promise((resolve, reject) => { if (!url || !filename || !directory) { reject('invalid url or directory or filename'); } else { resolve(); } }).then(() =>
    download(global.mainWindow, url, {
      directory,
      filename
      // onProgress: progress =>
      // mainWindow.webContents.send('parity-download-progress', progress) // Notify the renderers
    })).then(() => {
      console.log('downloadFile success !', filename);
      event.sender.send(`download-file-success-${filename}`);
    })
    .catch(e => {
      console.log('downloadFile error !', e);
      event.sender.send(`download-file-error-${filename}`, e);
    });
};
