import * as fs from 'fs';
import * as path from 'path';

export function getFileContentByName(fileName: string) {
  if (fs.existsSync(fileName)) {
    return fs.readFileSync(fileName, 'utf8');
  }
  return '';
}

export function getLastModifyFilePath(dir: string) {
  let filePath = '';

  if (fs.existsSync(dir)) {
    const arr = fs.readdirSync(dir);

    arr.forEach((item) => {
      var fullpath = path.join(dir, item);
      var stats = fs.statSync(fullpath);
      if (stats.isFile()) {
        if (stats.mtimeMs >= 0) {
          filePath = fullpath;
        }
      }
    });
  }
  return filePath;
}
