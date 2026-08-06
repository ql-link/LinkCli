import { AppError } from "../errors.js";
export function paginate<T>(items:T[], cursor:string|undefined, limit:number, id:(item:T)=>string) {
  let start=0;
  if (cursor) { try { const decoded=Buffer.from(cursor,"base64url").toString("utf8"); const index=items.findIndex((item)=>id(item)===decoded); if(index<0) throw new Error(); start=index+1; } catch { throw new AppError("INVALID_INPUT","Cursor is invalid",400); } }
  const data=items.slice(start,start+limit); const last=data.at(-1); const hasMore=start+data.length<items.length;
  return {data,nextCursor:hasMore&&last?Buffer.from(id(last)).toString("base64url"):null};
}
