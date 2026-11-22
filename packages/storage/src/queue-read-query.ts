import type {Client,QueryResult,QueryResultRow} from 'pg';

/** Scope planning overhead to this checked-out connection and restore pooled
 * state on failure. Frequent lineage reads must not recompile through JIT. */
export async function queryQueuePresentation<T extends QueryResultRow>(client:Client,text:string,values:unknown[]):Promise<QueryResult<T>>{
 const previous=String((await client.query('show jit')).rows[0].jit);
 if(previous==='off')return client.query<T>(text,values);
 await client.query("select set_config('jit','off',false)");
 try{return await client.query<T>(text,values);}
 finally{await client.query("select set_config('jit',$1,false)",[previous]);}
}
