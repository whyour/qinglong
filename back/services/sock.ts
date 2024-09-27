import { Service, Inject } from 'typedi';
import winston from 'winston';
import { Connection } from 'sockjs';
import { SockMessage } from '../data/sock';
import EventEmitter from 'events';

@Service()
export default class SockService extends EventEmitter{
  private clients: Connection[] = [];

  constructor(@Inject('logger') private logger: winston.Logger) { 
    super()
  }

  public getClients() {
    return this.clients;
  }

  public addClient(conn: Connection) {
    if (this.clients.indexOf(conn) === -1) {
      this.clients.push(conn);

      conn.on('data',(msg:string)=>{
        this.emit('message',msg,conn)
      });
    }
  }

  public removeClient(conn: Connection) {
    const index = this.clients.indexOf(conn);
    conn.removeAllListeners('data')

    if (index !== -1) {
      this.clients.splice(index, 1);
    }
  }

  public sendMessage(msg: SockMessage) {
    this.clients.forEach((x) => {
      x.write(JSON.stringify(msg));
    });
  }
}
