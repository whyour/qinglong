"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SockMessage = void 0;
class SockMessage {
    constructor(options) {
        this.type = options.type;
        this.message = options.message;
        this.references = options.references;
    }
}
exports.SockMessage = SockMessage;
//# sourceMappingURL=sock.js.map