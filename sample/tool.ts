import * as qiniu from 'qiniu';
import dotenv from 'dotenv';
const envFound = dotenv.config();

const accessKey = process.env.QINIU_AK;
const secretKey = process.env.QINIU_SK;
const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
const key = 'version.yaml';
const options = {
  scope: `${process.env.QINIU_SCOPE}:${key}`,
};
const putPolicy = new qiniu.rs.PutPolicy(options);
const uploadToken = putPolicy.uploadToken(mac);

const localFile = 'version.yaml';
const config = new qiniu.conf.Config({ zone: qiniu.zone.Zone_z1 });
const formUploader = new qiniu.form_up.FormUploader(config);
const putExtra = new qiniu.form_up.PutExtra(
  '',
  {},
  'text/plain; charset=utf-8',
);
// 文件上传
formUploader.putFile(
  uploadToken,
  key,
  localFile,
  putExtra,
  function (respErr, respBody, respInfo) {
    if (respErr) {
      throw respErr;
    }
    if (respInfo.statusCode == 200) {
      console.log(respBody);
    } else {
      console.log(respInfo.statusCode);
      console.log(respBody);
    }
  },
);
