import path from 'path';
import { Service } from 'typedi';
import config from '../config';
import { ScriptHistory } from '../shared/scriptHistory';

/** Panel configuration and lifecycle; the storage core stays independently testable. */
@Service()
export default class ScriptHistoryService extends ScriptHistory {
  constructor() {
    super(config.scriptPath, path.join(config.dataPath, 'script-history'));
  }
}
