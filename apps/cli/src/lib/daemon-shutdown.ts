import {setTimeout as delay} from 'node:timers/promises';

type SignalHost={once(event:'SIGTERM'|'SIGINT',listener:()=>void):unknown;removeListener(event:'SIGTERM'|'SIGINT',listener:()=>void):unknown};
/** Stop admission immediately; finish owned work before releasing the process. */
export function createDaemonShutdown(onStop:()=>void,host:SignalHost=process){
 const controller=new AbortController();
 const stop=()=>{if(!controller.signal.aborted){controller.abort();onStop();}};
 host.once('SIGTERM',stop);host.once('SIGINT',stop);
 return {
  requested:()=>controller.signal.aborted,
  stop,
  async wait(ms:number){try{await delay(ms,undefined,{signal:controller.signal});}catch(error){if((error as Error).name!=='AbortError')throw error;}},
  async drain(work:Promise<unknown>[]){await Promise.allSettled(work);},
  close(){host.removeListener('SIGTERM',stop);host.removeListener('SIGINT',stop);}
 };
}
