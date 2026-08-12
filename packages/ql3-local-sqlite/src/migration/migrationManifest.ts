import type { MigrationStreamManifest } from '@qinglong/runtime-core/migration-stream';
import { LOCAL_SQLITE_MIGRATION_STREAM_ID } from './migrationStreamStore';

/**
 * Runtime-safe reviewed migration history. Checksums are frozen audit facts; executable
 * SQL lives only behind the /migration entrypoint.
 */
export const localSqliteMigrationManifest: MigrationStreamManifest =
  Object.freeze({
    id: LOCAL_SQLITE_MIGRATION_STREAM_ID,
    dialect: 'sqlite',
    migrationIdScheme: 'sqlite-numbered',
    checksumScheme: 'sha256',
    migrations: Object.freeze([
      Object.freeze({
        id: '0001-run-core',
        checksum:
          '39568123409d2c7f0bc719418640552b71e9880bd7f04edf827c6b281111c1ed',
      }),
      Object.freeze({
        id: '0002-capability',
        checksum:
          '67742152a864e4e3b01dce74b547ff47f1630fe38d955b5f98a9e9c0d1a2f85f',
      }),
      Object.freeze({
        id: '0003-completion-receipt-journal',
        checksum:
          'f097d92e50be11812c8d501e173319e4142e7ea6b53b91e170f0f5bd46d0b454',
      }),
      Object.freeze({
        id: '0004-capability-v2',
        checksum:
          '74f26d198e73dbf1ec46ff1a0d5874c7a2ba4bd0bcfc49270b19111c0005fe10',
      }),
      Object.freeze({
        id: '0005-local-dispatch-plan',
        checksum:
          '20dea02fd01f6577624078d2ceae7f93939faa60fdb1a6bc145dab65f38388e9',
      }),
      Object.freeze({
        id: '0006-capability-v3',
        checksum:
          'ba2d32b53be6f9a5684178e33bdd3af6b48fb03532832eb359a273bd5be419e5',
      }),
      Object.freeze({
        id: '0007-local-secret-envelopes',
        checksum:
          'bc24730051cd8306ccb7e5ecbdb7911dd2352f8bcb4cd448a0a4eb3004b68224',
      }),
      Object.freeze({
        id: '0008-capability-v4',
        checksum:
          'eee83101204917ba2651dbbf962c5f8b6783223deecf298345f39b842afbc5e1',
      }),
      Object.freeze({
        id: '0009-local-project-policy-audit',
        checksum:
          '2dd3d535aa2cce27d4032ac8d0a9e0afe0e0ac05e0ed8f91328765a8ad9b3175',
      }),
      Object.freeze({
        id: '0010-capability-v5',
        checksum:
          '43e4d311fa5705588a5b66f3c32f942d220b7d86a23003f7b73ddad4bf6bb12d',
      }),
      Object.freeze({
        id: '0011-local-identity-credential',
        checksum:
          '9ad007caaf28a2e5310a84c0d08f8314ee8db17f309cfd323b86f763b0f349c9',
      }),
      Object.freeze({
        id: '0012-capability-v6',
        checksum:
          'c0a3321d546c98f651180802e94e8d819246b5e51449b749d8f0e82710464d0c',
      }),
      Object.freeze({
        id: '0013-local-owner-bootstrap',
        checksum:
          '83304887fc0a265b71e47b61d74554f63bccf0e0208d85c3e79e4cfd5dcbbe48',
      }),
      Object.freeze({
        id: '0014-capability-v7',
        checksum:
          '46df0f0fc48a8510adab4b34e0697eb21572267fce46c5764f0b7e35e412d50e',
      }),
      Object.freeze({
        id: '0015-local-owner-delivery-acknowledgements',
        checksum:
          'e4c5f4dd7f9a5f717054fea9f3eb3b4f0aa3c01ce66559bb55b47ab9928a5dfa',
      }),
      Object.freeze({
        id: '0016-capability-v8',
        checksum:
          'd5abd73e4422555e13d989e646523d766c07c4d2261026e53097d7e756d7265a',
      }),
      Object.freeze({
        id: '0017-api-credential-pepper-bindings',
        checksum:
          '32144992e70ea8ea1f45a5e88bfa7b94da6f7943349c0ec974e23e7ad14488e6',
      }),
      Object.freeze({
        id: '0018-capability-v9',
        checksum:
          'da15b963e45c49c5d145d7c5c9c06ab41921ff054a5573bb5ebb698da6524562',
      }),
      Object.freeze({
        id: '0019-local-owner-pepper-catalog',
        checksum:
          'b2c7afe88d02eb8e3bc0cceaa590edb252adf578f9d5a1292d5969a50847a89d',
      }),
      Object.freeze({
        id: '0020-capability-v10',
        checksum:
          'c5caf45785d4efe2885ffe857a59109acdc36ec1b79ca2079b0b6274f68d541b',
      }),
      Object.freeze({
        id: '0021-local-owner-credential-recovery',
        checksum:
          '7d52b983194d2078e33fef181e1cba115266ac7fb253415a71e222df873af507',
      }),
      Object.freeze({
        id: '0022-capability-v11',
        checksum:
          'bcb367bc095d97a47f512c002dd12e74314b36fbbbd71862d3441b810f94d006',
      }),
      Object.freeze({
        id: '0023-local-owner-pepper-material-gc',
        checksum:
          '995bf7b84d62381e1620347d3306349fcaa4c71c2072f23be504eeb93ca3e7d4',
      }),
      Object.freeze({
        id: '0024-capability-v12',
        checksum:
          '40f4819c3877cdc1626fc780a5ac916f6bb6f8d3d1a1d437f55dc2fd8afe9b0b',
      }),
      Object.freeze({
        id: '0025-local-owner-delivery-acknowledgement-gc',
        checksum:
          '3982b92013917606c561b6fe7a4fdaae72e4da3eae91befa1a19a44382e39507',
      }),
      Object.freeze({
        id: '0026-capability-v13',
        checksum:
          '2a606be91f4f216abddbfb6b6918971a7e5cf086df7c620de60fdb40d0849340',
      }),
      Object.freeze({
        id: '0027-task-definitions',
        checksum:
          '3ae15a3f964dbcbeacb311862ad52dd6489715fe87cfe1a8e8ec9bec59c2a81f',
      }),
      Object.freeze({
        id: '0028-capability-v14',
        checksum:
          '408fc34ad2aa5439b05ccf7438ee98bcc952cd2c72bcbf81931a0f6598e6039d',
      }),
      Object.freeze({
        id: '0029-local-execution-revision-digest',
        checksum:
          '273ebd3f10ee0f17b2037b446d67943d2c5d1e819ca61651abdb52de7245ccbf',
      }),
      Object.freeze({
        id: '0030-capability-v15',
        checksum:
          'c51cbab2a4f4747b14a7ddec4629356a923b840414efb52388a7ebe7e463a369',
      }),
      Object.freeze({
        id: '0031-trigger-definitions',
        checksum:
          'c3d37ccf8f62ed006f8236157c1917696d7d3ea41db1db14b662b76e2f1203da',
      }),
      Object.freeze({
        id: '0032-capability-v16',
        checksum:
          '28c927e5787323b4df2b39a755de8f7c629bea46f7bd1bac2502c6de93a4aba7',
      }),
      Object.freeze({
        id: '0033-legacy-adoption-ledger',
        checksum:
          '73cb0155c1321f15fbef3a22649d97278245fa1d3865391b4d053104f0102f80',
      }),
      Object.freeze({
        id: '0034-capability-v17',
        checksum:
          'a973fd2471d42844a5eb8f40b9a6ae4ed2aa1507ab8cae1b9de9a783d593f0f2',
      }),
      Object.freeze({
        id: '0035-local-scheduler',
        checksum:
          'eb312b03ea61f4d3fa4f8751d93ede7bf6b3c2c1893b785e8d83d24eda8f8c5e',
      }),
      Object.freeze({
        id: '0036-capability-v18',
        checksum:
          '0ea27d9d5be58c03a092f5717b64d6eae8a45fb732461ca684744a220ce1c1d1',
      }),
      Object.freeze({
        id: '0037-plugin-package-installs',
        checksum:
          '6d40e13043b6dddd7ef16c1562b17fa4faf3fbc832e152976ac6e5334ba26175',
      }),
      Object.freeze({
        id: '0038-capability-v19',
        checksum:
          '6709d442e985ffc91ea4622c3bc322c838c022745f498f5ea94b8503d286e0c4',
      }),
      Object.freeze({
        id: '0039-approved-actions',
        checksum:
          '2f0a258aaf99eb83e28af76b95529dd0c76b8f6ea28baa3d3cdbfd353ad6eef9',
      }),
      Object.freeze({
        id: '0040-capability-v20',
        checksum:
          'c06ce8f021a4e1874e14deb4b824a45273a1e96f5625a487f2e6d940ce364ee2',
      }),
      Object.freeze({
        id: '0041-plugin-package-admission-receipts',
        checksum:
          'fac42799fad2b80c34d49f922ccd42e5b9f213435767ae7efb865370f6799432',
      }),
      Object.freeze({
        id: '0042-capability-v21',
        checksum:
          'b4789c615f92299b8dac879c75d377ddddf22e547f069ee8ccc9a16647b21410',
      }),
      Object.freeze({
        id: '0043-approved-action-executions-and-package-proposals',
        checksum:
          'e0d2d5718e2e58e5cc841bff67d3b533840a727ea0d860850c67c6d4e4edbba9',
      }),
      Object.freeze({
        id: '0044-capability-v22',
        checksum:
          '9ae0d6d3dde8f4e09abefab67cedd4cfdb9f5ad9725f136e69e1c9480d1bb99b',
      }),
      Object.freeze({
        id: '0045-plugin-package-materialized-revisions',
        checksum:
          '935b2c1806bdb2c45fafc9813089070088c8f660f2f4b479a3866d790b161f8b',
      }),
      Object.freeze({
        id: '0046-capability-v23',
        checksum:
          '5d874653fe3971a52c71d3706b89f38aefc03fe00c28fb6ba23f2249413cf8c0',
      }),
      Object.freeze({
        id: '0047-plugin-package-task-reconciliations',
        checksum:
          'cc4caf2409c513d982d910ff853cbebf281e7999c8e1b2e6d00d50f0e6ebc2f2',
      }),
      Object.freeze({
        id: '0048-capability-v24',
        checksum:
          'd2257f4b08f01703507c49d7b2bf197930a88eb70d6e07ab13b3627657df0031',
      }),
      Object.freeze({
        id: '0049-project-tool-definition-snapshots',
        checksum:
          '7b7d02243fb3ab3fce5444dd73dba96a4e16598f082a4c0e786404b860266831',
      }),
      Object.freeze({
        id: '0050-capability-v25',
        checksum:
          '9d128ecd3bac1a45e7bea1cde1e6f5fee364761de673cb2116b4abc2e8b492af',
      }),
      Object.freeze({
        id: '0051-step-runs',
        checksum:
          '3a659aff64ad2927a886b0e3f4309139a379f0a91f90ae147fd959d7db461a2a',
      }),
      Object.freeze({
        id: '0052-capability-v26',
        checksum:
          '613ba0cddf1ed12ab00f4e3bf87e11cd14bac497c6502015496c58d909dfc5fc',
      }),
      Object.freeze({
        id: '0053-tool-execution-evidence',
        checksum:
          '315cbdba8af417d38435d44317a1ada33a0b7b38a8a4f06ab08ba434a63e6a12',
      }),
      Object.freeze({
        id: '0054-capability-v27',
        checksum:
          '8b6e33971669562b42ac7bd31689cbeff1247a71eea0b5533ab53cd8b2ec3551',
      }),
      Object.freeze({
        id: '0055-tool-execution-start-barriers',
        checksum:
          '2209e9dbb301263ea79f7a3a08b61dc81586586c54eabed6c3911a10b81bc628',
      }),
      Object.freeze({
        id: '0056-capability-v28',
        checksum:
          '58fe4e491d8c9e013fe94297e6a5d35591a524b19af468e9a7c1ae94750296a2',
      }),
      Object.freeze({
        id: '0057-tool-invocation-artifacts',
        checksum:
          '430aeddb502e14ad750f56987ce7cfa8de8425e410ae859fae4b84b5120633a6',
      }),
      Object.freeze({
        id: '0058-capability-v29',
        checksum:
          'e5cbd9874d5cc54aa4b99afcf26b3d514c329e00b32f09980d409c8d91fc164e',
      }),
      Object.freeze({
        id: '0059-tool-execution-artifact-bindings',
        checksum:
          '0298421262b7b4b8accf4f9eba7619735399a6de8a4a11db51561f1fe9204c9d',
      }),
      Object.freeze({
        id: '0060-capability-v30',
        checksum:
          'e05c92b3f01b2e38b71d18b63ba7d1932b971861d10c5d17b348ee1446b0efd9',
      }),
      Object.freeze({
        id: '0061-tool-execution-completions',
        checksum:
          'b17111ce2f486a357931fe05d23fd7eccce3140793f1224ab59c20e922c615eb',
      }),
      Object.freeze({
        id: '0062-capability-v31',
        checksum:
          '4e1aff95a4b573ca8147fbbdded001fb3a7dbbf657469eb08491a8e398cab367',
      }),
      Object.freeze({
        id: '0063-tool-execution-failure-completions',
        checksum:
          'a6894b10361bbcf98f36e59cd79d8546f51ea45b1aa3798f20bfb54b00ea6712',
      }),
      Object.freeze({
        id: '0064-capability-v32',
        checksum:
          '076978dabd6042cc04dc8ccb339a9eb788808bb12bcadd255b870f69fe5acc11',
      }),
      Object.freeze({
        id: '0065-tool-result-key-catalog',
        checksum:
          'f7d241395920688e311dfc195bf051e3211e0ba7b39d5e97e0142df9cbb425d2',
      }),
      Object.freeze({
        id: '0066-capability-v33',
        checksum:
          'ab5e64b4c4ae1fa23f8bb25cb34a83898d934f87744c4e0e98bdbbba678db669',
      }),
      Object.freeze({
        id: '0067-tool-result-rekey-overlays',
        checksum:
          'b03d99ab33e53916890a1d2220038f7d3012162579a526e7c04aa54e775e7d89',
      }),
      Object.freeze({
        id: '0068-capability-v34',
        checksum:
          '17d8a86261f4378f57efd3f134cc83d412a76a49a462380cd9c6976c326b635f',
      }),
      Object.freeze({
        id: '0069-plugin-package-quarantine',
        checksum:
          '9e6055352f11c3d156551d3d4f5fb043e19193ed24a6517db2a0567e79cf3cf0',
      }),
      Object.freeze({
        id: '0070-capability-v35',
        checksum:
          'bbca98db050d676174e23906cdeb065bdfa375d54673ed8ee898577c44694c82',
      }),
      Object.freeze({
        id: '0071-local-identity-credential-administration',
        checksum:
          '94524df88e410a8c7f2b28832766f5dccc3d81e7075112819d51567c88896f77',
      }),
      Object.freeze({
        id: '0072-capability-v36',
        checksum:
          '339b0d4ab576813aa37ee4b3347db68f415c01016c8fd8e0b293ae9e89ac1ba1',
      }),
      Object.freeze({
        id: '0073-local-project-administration',
        checksum:
          'd8881e79284d4e63622ae7addc4d272c301290b83ca455ca642eb706c293093f',
      }),
      Object.freeze({
        id: '0074-capability-v37',
        checksum:
          '3af70476c4a56b12dd208a3bee6cbe7da99788a7965e9691a36608afa88fa9ef',
      }),
      Object.freeze({
        id: '0075-security-audit-compactions',
        checksum:
          'ccb424944e1392ed9a503d1d365fcaf6d0a4258b411eae0dc21da2f6fdf88b7e',
      }),
      Object.freeze({
        id: '0076-capability-v38',
        checksum:
          'c73d5de0a6c846c606e2c345800f9fce570fced43cbe946e558f5ccc58a235b3',
      }),
      Object.freeze({
        id: '0077-plugin-package-lifecycle',
        checksum:
          '9b308b31a53897e726f3e23a7ac3158754885d1d3aa487be5a7ec6a631fe1f71',
      }),
      Object.freeze({
        id: '0078-capability-v39',
        checksum:
          'b9e26a65125bf43a40aee0a47eac65cf232411b084af2672ae06ef834dc17252',
      }),
      Object.freeze({
        id: '0079-plugin-package-automation-publications',
        checksum:
          '6e4ede9a5b6c1480bba99bab3d257e5138cd8b3a7841d8fd5d6252dd264e78fd',
      }),
      Object.freeze({
        id: '0080-capability-v40',
        checksum:
          '3cfd4dd22b3c0f399be3b3e6b1f85f65065c53a6b97361faa8c9ce5e0ec35702',
      }),
      Object.freeze({
        id: '0081-plugin-package-workflow-admissions',
        checksum:
          '129e98a34ff88669218f31847b735a26afed9401a01d8384d71d04613adc51a3',
      }),
      Object.freeze({
        id: '0082-capability-v41',
        checksum:
          '2ca9170340ef13d608e2f417df0a8a7df5252bf7a0dba81b1edc149a311e503c',
      }),
      Object.freeze({
        id: '0083-plugin-package-workflow-task-attempt-admissions',
        checksum:
          'de30414a9667309960e99c6b232904e1fee769d6d319340ec8f40a36daeb213b',
      }),
      Object.freeze({
        id: '0084-capability-v42',
        checksum:
          '0755449ac02f97e2b4074bd768e84d30fa62c9274d6f87370cff1b628fb0825e',
      }),
      Object.freeze({
        id: '0085-plugin-package-workflow-run-list-index',
        checksum:
          '7f595bb1d0daf38a0f50594859ee475e5a377656b9ca086583ad1089911e1247',
      }),
      Object.freeze({
        id: '0086-capability-v43',
        checksum:
          'd7affd7b3d1f3719dabc7abc7d5e8a2880fc4dc455b5103585befe9b51f705f9',
      }),
      Object.freeze({
        id: '0087-run-attempt-log-retention',
        checksum:
          'b13088c1926150ada6f010d7c694b3cf603ad44646991e77c713b882aba0e416',
      }),
      Object.freeze({
        id: '0088-capability-v44',
        checksum:
          'c47a61b140b54d448c30ce7d5f7927c0d16fb897ab36dbe1d6010da2c39075a7',
      }),
      Object.freeze({
        id: '0089-plugin-package-automation-disposition-events',
        checksum:
          '3eaff9c7621fc4a69a7605fd7de29d38dfde856df13b5e467ccc2bf1245e21aa',
      }),
      Object.freeze({
        id: '0090-capability-v45',
        checksum:
          '1919987d29ef581e150116c590f1dc98f5d327791fc6425d5f1a27b8f6de5475',
      }),
      Object.freeze({
        id: '0091-plugin-package-secret-bindings',
        checksum:
          '21e9957eb4c8cad0e41377d59c9f3226c350f9ae4718642c2caeb88a308f43ee',
      }),
      Object.freeze({
        id: '0092-capability-v46',
        checksum:
          'a1b058bb7b0259069202632d27d4a55466828cde831c49821eb862feeba6ce35',
      }),
    ]),
  });
