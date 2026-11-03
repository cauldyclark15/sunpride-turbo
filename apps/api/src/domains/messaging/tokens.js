import { isUuid } from "../../core/util.js";
import { types, find } from "./refs/common.js";
import { invalid } from "./model.js";
/** Parse canonical tokens without changing the stored body. Reject partial/unknown tokens.
 * @param {string} body */
export function parseTokens(body) {
  /** @type {{kind:string,user_id?:string,ref_type?:string,ref_id?:string}[]} */ const tokens =
    [];
  let channel = false;
  const remainder = body.replace(/<[@#!][^<>]*>/g, (token) => {
    if (token === "<!channel>") {
      channel = true;
      return "";
    }
    const mention = /^<@user:([^:<>]+)>$/.exec(token);
    if (mention && isUuid(mention[1])) {
      tokens.push({ kind: "user", user_id: mention[1] });
      return "";
    }
    const object = /^<#([a-z_]+):([^:<>]+)>$/.exec(token);
    if (object && types.includes(object[1] ?? "") && isUuid(object[2])) {
      tokens.push({ kind: "object", ref_type: object[1], ref_id: object[2] });
      return "";
    }
    throw invalid("Invalid mention or object tag");
  });
  if (/<[@#!]/.test(remainder))
    throw invalid("Incomplete mention or object tag");
  return {
    tokens: [...new Map(tokens.map((t) => [JSON.stringify(t), t])).values()],
    channel,
  };
}
/** @param {any} db @param {any} row */
export async function saveMentions(db, row) {
  const parsed = parseTokens(row.body);
  await db`delete from chat_mentions where message_id=${row.id}`;
  for (const t of parsed.tokens) {
    if (
      !(await find(
        db,
        t.kind === "user" ? "user" : /** @type {string} */ (t.ref_type),
        /** @type {string} */ (t.user_id ?? t.ref_id),
      ))
    )
      throw invalid("Mentioned item does not exist");
    await db`insert into chat_mentions(message_id,kind,user_id,ref_type,ref_id) values(${row.id},${t.kind},${t.user_id ?? null},${t.ref_type ?? null},${t.ref_id ?? null})`;
  }
  if (parsed.channel)
    await db`insert into chat_mentions(message_id,kind,user_id) select ${row.id},'user',user_id from chat_members
  where conversation_id=${row.conversation_id} and left_at is null and not exists(select 1 from chat_mentions x where x.message_id=${row.id} and x.user_id=chat_members.user_id)`;
}
