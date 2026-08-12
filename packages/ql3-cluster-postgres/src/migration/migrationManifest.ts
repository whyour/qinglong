import type { MigrationStreamManifest } from '@qinglong/runtime-core';
import { POSTGRESQL_MAIN_MIGRATION_STREAM_ID } from '../migrations/postgresMigrationStreamStore';

export const postgresqlMainMigrationManifest: MigrationStreamManifest =
  Object.freeze({
    id: POSTGRESQL_MAIN_MIGRATION_STREAM_ID,
    dialect: 'postgresql',
    migrationIdScheme: 'postgres-prefixed',
    checksumScheme: 'sha256',
    migrations: Object.freeze([
      Object.freeze({
        id: 'pg-0001-schema-capability',
        checksum:
          '9e3499e3bcdfe3d7b2559e64ea7bbf236a8a11ba32d6a45af131034887d5a8ab',
      }),
      Object.freeze({
        id: 'pg-0002-run-core',
        checksum:
          '5b59a7f9323746e49c6c321e89007f553a0751f25d16ffd23c3ae37dd87f76e4',
      }),
      Object.freeze({
        id: 'pg-0003-run-retry-policy',
        checksum:
          '621792cde917cc86809bbebff389443e790bdba60f73d04f7a1dc97a0ebf72db',
      }),
      Object.freeze({
        id: 'pg-0004-project-policy',
        checksum:
          '715675d1725687438106c01193f9b87368705c89793d1553c7cbfa7ddefc2343',
      }),
      Object.freeze({
        id: 'pg-0005-api-credential-security-audit',
        checksum:
          'd19134de8639df125a8ee4ae4056d6493bf9be4bb2bd28ba3ea1db2a4bf119df',
      }),
      Object.freeze({
        id: 'pg-0006-identity-credential-administration',
        checksum:
          'fe2e87ad191a185a6187d1ef350b7fb49bc13cb56bef610669a59838103b2f87',
      }),
      Object.freeze({
        id: 'pg-0007-cluster-recovery-indexes',
        checksum:
          'e7e20ee7789a90ddf68eacbb25a9a4e7f4101358b4fb7fd10fa1d4f256e4b5dd',
      }),
      Object.freeze({
        id: 'pg-0008-run-recovery-claims',
        checksum:
          '1f32c1dd83107eb1881e1b0e968c59fb33e0c63bb8d526b6cde6f350c07652db',
      }),
      Object.freeze({
        id: 'pg-0009-worker-session-run-lease',
        checksum:
          '6be7e5380ca4d71aa6fcbe9170e0c9beb67aa976800ce75167aab44c41ae335b',
      }),
      Object.freeze({
        id: 'pg-0010-worker-ingress-attestation',
        checksum:
          'bbc1c36d3d8d3d162073988c8abcf94795fded80277a56b7ac6aa48544caf367',
      }),
      Object.freeze({
        id: 'pg-0011-api-credential-pepper-binding',
        checksum:
          '12e76002c42f8409ca417fbb562e29d407eaa57324567d80605471eb9e0fa7a4',
      }),
      Object.freeze({
        id: 'pg-0012-task-trigger-definitions',
        checksum:
          '963e99d1aec9de46fd8ec034480f6c78dc904e30fe85d1b3790224c66f628055',
      }),
      Object.freeze({
        id: 'pg-0013-task-execution-revisions',
        checksum:
          'a09b34cfda9102c1c573479f61a70f39a786ccd8b45bb82b640935ede4cb6301',
      }),
      Object.freeze({
        id: 'pg-0014-cluster-scheduler-admission',
        checksum:
          '5f58a214fb2321c2193bf1f3c4e231d9bc2116cd56fd8550bbc23c81cdbf566d',
      }),
      Object.freeze({
        id: 'pg-0015-worker-credential-delivery-ledger',
        checksum:
          'e8bcef07055a748a4858ae502233138da4c0b4f9f2ea3d3a02bd9264da61f4a4',
      }),
      Object.freeze({
        id: 'pg-0016-worker-credential-stage-discard-ledger',
        checksum:
          '8e749a3c16fc9c995124bb80fbe67bb4de30ad20c0a1591f283a0dbf1ce243a0',
      }),
      Object.freeze({
        id: 'pg-0017-database-role-grants',
        checksum:
          '3bb01c0f0dcab152c01b6ba374e60f0aaae7e7464d589fc76626d5d8191fe9f0',
      }),
      Object.freeze({
        id: 'pg-0018-plugin-package-installs',
        checksum:
          '300bd91155c6480f4397f903645022fa980d71fabe592d42584b1402328f5348',
      }),
      Object.freeze({
        id: 'pg-0019-approved-actions',
        checksum:
          '96fd50dc1e42f7b2f54af670460d7b486f2fa7c6a234ea1debad120436fcd40c',
      }),
      Object.freeze({
        id: 'pg-0020-plugin-package-admission-receipts',
        checksum:
          'b1ae4af68d274eb4324e5fd521f42bfb99c1a81478cc9f57c9b604cd393ea8cf',
      }),
      Object.freeze({
        id: 'pg-0021-approved-action-executions-and-package-proposals',
        checksum:
          '6f65ca0dcb25ea56b32e82d40a5a7a6b2be6cf9ed4a48d04107ef01e44f1cd6a',
      }),
      Object.freeze({
        id: 'pg-0022-plugin-package-authority-split',
        checksum:
          '431c7c454583629a46a45bb88107765ef600185d3606bfedabb0ca0e40138bf6',
      }),
      Object.freeze({
        id: 'pg-0023-plugin-package-management-quota',
        checksum:
          '9e3d1bd16bcb2712885de8f0a094289a60c20dc0e4ed9d90ed5adcf1b0240380',
      }),
      Object.freeze({
        id: 'pg-0024-plugin-package-identity-keyset-ledger',
        checksum:
          '0c764e9427632a79033ecd75a600e3788b9f7b9b39f55899d2c9d1e2d033105f',
      }),
      Object.freeze({
        id: 'pg-0025-plugin-package-materialized-revisions',
        checksum:
          'da6413393e26f369a9f2639dbd7a0b25bbd079f5de3c61e96e74f0fb10953a54',
      }),
      Object.freeze({
        id: 'pg-0026-plugin-package-task-reconciliations',
        checksum:
          'b46c241d958cbc34c2e6052708dbc13e040abc3db92c58b0d5915f05c322a32f',
      }),
      Object.freeze({
        id: 'pg-0027-project-tool-definition-snapshots',
        checksum:
          '147b413aa7eee0469c23d1895f4b9136ffa90da999370c9ca9d293e94afe0960',
      }),
      Object.freeze({
        id: 'pg-0028-step-runs',
        checksum:
          'a5fd40534f582d07ff5851aa3b856a872a3685e8c975725e8eacf0f6a44ec04a',
      }),
      Object.freeze({
        id: 'pg-0029-tool-execution-evidence',
        checksum:
          'c61683499c5d65ad319b2ce18ec94b001131381e9d118ed56f05626f6f83d5c6',
      }),
      Object.freeze({
        id: 'pg-0030-tool-execution-start-barriers',
        checksum:
          'dba5dd522bc9cc7d7cce1432d14262c0195637c9f407d21bb6dc93b24a5018a7',
      }),
      Object.freeze({
        id: 'pg-0031-tool-invocation-artifacts',
        checksum:
          'b95d9953315aed36a204caa26f2aba5fe9b2893f67f036c8c118bd5551a0a641',
      }),
      Object.freeze({
        id: 'pg-0032-tool-execution-artifact-bindings',
        checksum:
          '9dd8c3ce052124370bfef691e21cc582331ce527b0d69740549d3d440bec4946',
      }),
      Object.freeze({
        id: 'pg-0033-tool-execution-completions',
        checksum:
          '1ada1837e4473c3e4f27437ede826832cc590aa47f8e8bfa512fa0fadd8dd291',
      }),
      Object.freeze({
        id: 'pg-0034-tool-execution-failure-completions',
        checksum:
          '77aa1e86f748f59b84cb4546f0c376ca2bf6ee424bf1b5b3b7fe4970b8056c2f',
      }),
      Object.freeze({
        id: 'pg-0035-tool-result-key-catalog',
        checksum:
          '64af556669d93e5cf20a29f5df3842280e56029188e1c719f30325b4b75b84ff',
      }),
      Object.freeze({
        id: 'pg-0036-tool-result-rekey-overlays',
        checksum:
          '3d4fb20c52502b8a5609a8242adb17eb0348f7dc7fa65f793d61136d54b5c851',
      }),
      Object.freeze({
        id: 'pg-0037-plugin-package-quarantine',
        checksum:
          'a388c7e49a9fe6e417fb343e4ce30dd1b774513c726696ac387d6a1f9884bcb2',
      }),
      Object.freeze({
        id: 'pg-0038-plugin-package-publisher-provenance',
        checksum:
          'faa63ec953c41fa75c25c69fce017c07539080a9e8c321b107d067405db6a4ec',
      }),
      Object.freeze({
        id: 'pg-0039-plugin-package-publisher-trust-authority',
        checksum:
          'e0ee11727cbc5342bf480e2cc3142971ff256182d56fa960fe4a35f5c3333afe',
      }),
      Object.freeze({
        id: 'pg-0040-plugin-package-publisher-trust-transitions',
        checksum:
          'c45ab5c687b62555530035a11370e7094f7b5608505b02d3325804cc680c23fb',
      }),
      Object.freeze({
        id: 'pg-0041-plugin-package-lifecycle',
        checksum:
          '99669c63c891124aa0741586d5e92bd40d7a3ddf322ec7da970790958f554101',
      }),
      Object.freeze({
        id: 'pg-0042-plugin-package-lifecycle-plans',
        checksum:
          'a242067854f4ee5231c75874fa77dda364da962a2dcaf570b5015ee069818c4b',
      }),
      Object.freeze({
        id: 'pg-0043-plugin-package-automation-publications',
        checksum:
          'f93d3a1205c12b252ae31da08b401cad570c1d7f1dea48e83901eff4afe214b9',
      }),
      Object.freeze({
        id: 'pg-0044-plugin-package-automation-start-guard',
        checksum:
          'd4f436769e4845c220196f9a0ee4845cc9dae6b2fcd229486f42e4d87e11effd',
      }),
      Object.freeze({
        id: 'pg-0045-plugin-package-workflow-admissions',
        checksum:
          'e31520b150eb8991004f773ccd8f4fb9ec2bb559ef0750391f28038aeae43b7e',
      }),
      Object.freeze({
        id: 'pg-0046-plugin-package-workflow-task-attempt-admissions',
        checksum:
          '2c5316c9b4e60a1601d9ad0346f56261e6f15ee9368044e632154adb6fe45b7b',
      }),
      Object.freeze({
        id: 'pg-0047-worker-credential-management-plans',
        checksum:
          '2004c64019beb6971d43507160a7bd488baba12eb299fde3681a731800145d6a',
      }),
      Object.freeze({
        id: 'pg-0048-worker-credential-preapproved-activation',
        checksum:
          'cf37300e40a127b08c118c0bbb352035937af935455709fe5569d458ef91df8b',
      }),
      Object.freeze({
        id: 'pg-0049-worker-credential-execution-receipts',
        checksum:
          'd606e51a326b50f8969942c83b3d06d3ed4aa94618fbc5b25005006016918af9',
      }),
      Object.freeze({
        id: 'pg-0050-worker-credential-management-boundary',
        checksum:
          '9555dd93ab076bf450cfdf16e2178586a2c58738359266fa5d5345c938913555',
      }),
      Object.freeze({
        id: 'pg-0051-automation-management-boundary',
        checksum:
          '1f5e2beff59570163cee7ba2f798a149b5108522bc9db05ecb387d99cc0f96f5',
      }),
      Object.freeze({
        id: 'pg-0052-automation-management-identity-keyset-ledger',
        checksum:
          '8594427ad2d53caf61891d21296c140f43ca8204cf728c66784c6db48b7743cd',
      }),
      Object.freeze({
        id: 'pg-0053-plugin-package-workflow-run-list-index',
        checksum:
          '1848d8ffcf930462a0beab1220860ac6a626228511a0f55e997077bcb6ef4b63',
      }),
      Object.freeze({
        id: 'pg-0054-approval-management-boundary',
        checksum:
          '5e3e6b222269f095e0d7a985fdeb0ea154510e59dfe15873192af8c8d603fca3',
      }),
      Object.freeze({
        id: 'pg-0055-run-attempt-log-retention',
        checksum:
          'c775c65ec03ae3a1606f899064d2d38fa63fd136ce52cbd1b1172c3a51e6bf30',
      }),
      Object.freeze({
        id: 'pg-0056-run-management-boundary',
        checksum:
          '7aa2b2ade67cdfa6839d4af02209906646a68adfd6c12c4dddeb854021da72b8',
      }),
      Object.freeze({
        id: 'pg-0057-run-management-stop-boundary',
        checksum:
          'ab2d0eee3d85a937e1e87243b1fd1e75181529122b64026303488404162e4ba7',
      }),
    ]),
  });
