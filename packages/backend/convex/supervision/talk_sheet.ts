import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import schema from "../schema";
import { localDate, manilaDate } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { requireCapability } from "../lib/capabilities";
import { supervisionArgs, supervisorContext } from "./access";
import {
  carriesOver,
  daysBetween,
  effectiveStatus,
  finalizeGaps,
  GAP_LABELS,
  isDate,
  MAX_ITEMS,
  MAX_SHORT_TEXT,
  MAX_TEXT,
  partnerKey,
  rootCauseDue,
  talkSheetItemInput,
  talkSheetItemStatus,
  talkSheetTopic,
  type TalkSheetItemInput,
} from "./talk_sheet_model";
import { assignmentAt } from "./work_with";

/**
 * SOP-011 Talk Sheet (memo Annex E). The SFI sales representative (any role holding
 * `visit.record`) writes a sheet per meeting with an Area Distribution Partner inside
 * their scope; supervisors (`people.read` + `visit.read`) see every partner chain in scope,
 * its open items, overdue lines and lines due for a root-cause re-review.
 *
 * Carry-over invariant: a new sheet copies every On-going/Overdue line of the chain's
 * previous final sheet; a carried line cannot be removed, so it leaves the chain only by
 * being marked Completed on a sheet that is then finalized.
 */

const DAY = 86_400_000;
/** How far back or ahead a meeting may be dated. */
const DATE_WINDOW_DAYS = 31;
const MAX_SHEETS = 300;
const MAX_MINE = 100;

function text(value: string, label: string, max = MAX_TEXT) {
  if (value.length > max) throw new ConvexError(`${label} is too long`);
  return value.trim();
}

async function sheetItems(ctx: QueryCtx, sheetId: Id<"talkSheets">) {
  return await ctx.db
    .query("talkSheetItems")
    .withIndex("by_sheetId_and_position", (q) => q.eq("sheetId", sheetId))
    .take(MAX_ITEMS + 1);
}

/** The latest sheet of a chain (by meeting date), draft or final. */
async function chainLatest(
  ctx: QueryCtx,
  orgUnitId: Id<"orgUnits">,
  key: string,
) {
  return await ctx.db
    .query("talkSheets")
    .withIndex("by_orgUnitId_and_partnerKey_and_meetingDate", (q) =>
      q.eq("orgUnitId", orgUnitId).eq("partnerKey", key),
    )
    .order("desc")
    .first();
}

async function ownDraft(ctx: MutationCtx, sheetId: Id<"talkSheets">) {
  const { identity, profile } = await requireCapability(ctx, "visit.record");
  const sheet = await ctx.db.get(sheetId);
  if (!sheet || sheet.ownerProfileId !== profile._id)
    throw new ConvexError("Talk Sheet not found");
  if (sheet.status !== "draft")
    throw new ConvexError("This Talk Sheet is already signed off");
  await requireCapability(ctx, "visit.record", sheet.orgUnitId);
  return { identity, profile, sheet };
}

/**
 * Start the next Talk Sheet with a partner. The chain's previous sheet must be signed off;
 * its On-going and Overdue lines are copied in (Annex E carry-over rule).
 */
export const create = mutation({
  args: { partnerName: v.string(), meetingDate: v.string() },
  returns: v.id("talkSheets"),
  handler: async (ctx, args) => {
    const { identity, profile } = await requireCapability(ctx, "visit.record");
    const dayStart = localDate(args.meetingDate);
    const now = Date.now();
    if (
      Math.abs(dayStart - localDate(manilaDate(now))) >
      DATE_WINDOW_DAYS * DAY
    )
      throw new ConvexError(
        `A Talk Sheet must be dated within ${DATE_WINDOW_DAYS} days of today`,
      );
    const partnerName = text(args.partnerName, "Partner", MAX_SHORT_TEXT)
      .replace(/\s+/g, " ")
      .trim();
    if (!partnerName) throw new ConvexError("Name the partner");
    const key = partnerKey(partnerName);
    const assignment = await assignmentAt(ctx, profile._id, now);
    const orgUnitId = assignment?.orgUnitId ?? profile.orgUnitId;
    if (!orgUnitId)
      throw new ConvexError("Your access has no organizational unit");
    await requireCapability(ctx, "visit.record", orgUnitId);
    const previous = await chainLatest(ctx, orgUnitId, key);
    if (previous?.status === "draft")
      throw new ConvexError(
        `Sign off the open Talk Sheet with ${previous.partnerName} first`,
      );
    if (previous && args.meetingDate <= previous.meetingDate)
      throw new ConvexError(
        `The next Talk Sheet must be dated after ${previous.meetingDate}`,
      );
    const sheetId = await ctx.db.insert("talkSheets", {
      organizationId: SUNPRIDE_ORGANIZATION_ID,
      orgUnitId,
      partnerName,
      partnerKey: key,
      ownerProfileId: profile._id,
      meetingDate: args.meetingDate,
      status: "draft",
      ...(previous ? { previousSheetId: previous._id } : {}),
      createdBy: identity.tokenIdentifier,
      createdAt: now,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    if (previous) {
      let position = 0;
      for (const item of await sheetItems(ctx, previous._id)) {
        const status = effectiveStatus(item, args.meetingDate);
        if (!carriesOver(status)) continue;
        await ctx.db.insert("talkSheetItems", {
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          sheetId,
          position: position++,
          topic: item.topic,
          gap: item.gap,
          agreement: item.agreement,
          correctiveAction: item.correctiveAction,
          responsible: item.responsible,
          timeline: item.timeline,
          status,
          ...(item.rootCause ? { rootCause: item.rootCause } : {}),
          openedOn: item.openedOn,
          originItemId: item.originItemId ?? item._id,
          carriedFromItemId: item._id,
        });
      }
    }
    return sheetId;
  },
});

function cleanItem(row: TalkSheetItemInput) {
  const timeline = row.timeline.trim();
  if (timeline && !isDate(timeline))
    throw new ConvexError("Timeline must be a date");
  const rootCause =
    row.rootCause === undefined ? "" : text(row.rootCause, "Root cause");
  return {
    topic: row.topic,
    gap: text(row.gap, "Gap or issue"),
    agreement: text(row.agreement, "Agreement"),
    correctiveAction: text(row.correctiveAction, "Corrective action"),
    responsible: text(row.responsible, "Responsible", MAX_SHORT_TEXT),
    timeline,
    status: row.status,
    rootCause: rootCause || undefined,
  };
}

/**
 * Save the draft: header fields passed are replaced; `items`, when passed, is the full
 * ordered list of lines. Lines carried from the previous sheet keep their topic, issue
 * and first-raised date and cannot be removed — they close only at Completed.
 */
export const save = mutation({
  args: {
    sheetId: v.id("talkSheets"),
    acknowledgedByName: v.optional(v.string()),
    nextContactDate: v.optional(v.string()),
    items: v.optional(v.array(talkSheetItemInput)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, sheet } = await ownDraft(ctx, args.sheetId);
    const patch: Partial<Doc<"talkSheets">> = {};
    if (args.acknowledgedByName !== undefined)
      patch.acknowledgedByName =
        text(args.acknowledgedByName, "Acknowledged by", MAX_SHORT_TEXT) ||
        undefined;
    if (args.nextContactDate !== undefined) {
      const next = args.nextContactDate.trim();
      if (next && !isDate(next))
        throw new ConvexError("Next contact must be a date");
      patch.nextContactDate = next || undefined;
    }
    if (args.items !== undefined) {
      if (args.items.length > MAX_ITEMS)
        throw new ConvexError("Too many lines on one Talk Sheet");
      const existing = await sheetItems(ctx, sheet._id);
      const byId = new Map(existing.map((row) => [row._id as string, row]));
      const kept = new Set<string>();
      for (const [position, input] of args.items.entries()) {
        const clean = cleanItem(input);
        if (input.itemId === undefined) {
          const { rootCause, ...rest } = clean;
          await ctx.db.insert("talkSheetItems", {
            organizationId: SUNPRIDE_ORGANIZATION_ID,
            sheetId: sheet._id,
            position,
            ...rest,
            ...(rootCause ? { rootCause } : {}),
            openedOn: sheet.meetingDate,
          });
          continue;
        }
        const stored = byId.get(input.itemId);
        if (!stored || kept.has(input.itemId))
          throw new ConvexError("Talk Sheet line not found");
        kept.add(input.itemId);
        const carried = stored.carriedFromItemId !== undefined;
        await ctx.db.patch(stored._id, {
          position,
          ...clean,
          // A carried issue is the same issue: only its handling may change.
          ...(carried ? { topic: stored.topic, gap: stored.gap } : {}),
        });
      }
      for (const row of existing) {
        if (kept.has(row._id)) continue;
        if (row.carriedFromItemId !== undefined)
          throw new ConvexError(
            "A carried line closes only at Completed; it cannot be removed",
          );
        await ctx.db.delete(row._id);
      }
    }
    await ctx.db.patch(sheet._id, {
      ...patch,
      updatedBy: identity.tokenIdentifier,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Sign off the sheet (Discussed by / Acknowledged & Committed by). Refused, listing what is
 * missing, until every line is complete. Each line's status is frozen as of the meeting
 * date, so a line past its timeline is recorded Overdue.
 */
export const finalize = mutation({
  args: { sheetId: v.id("talkSheets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { identity, sheet } = await ownDraft(ctx, args.sheetId);
    const now = Date.now();
    if (sheet.meetingDate > manilaDate(now))
      throw new ConvexError(
        "A Talk Sheet cannot be signed off before its meeting",
      );
    const items = await sheetItems(ctx, sheet._id);
    const gaps = finalizeGaps({ ...sheet, items });
    if (gaps.length)
      throw new ConvexError(
        `Talk Sheet is not complete: ${gaps.map((gap) => GAP_LABELS[gap]).join("; ")}`,
      );
    for (const item of items) {
      const status = effectiveStatus(item, sheet.meetingDate);
      if (status !== item.status) await ctx.db.patch(item._id, { status });
    }
    await ctx.db.patch(sheet._id, {
      status: "final",
      finalizedAt: now,
      updatedBy: identity.tokenIdentifier,
      updatedAt: now,
    });
    return null;
  },
});

/** Throw away an unsigned draft; the previous sheet's open lines stay open for the next. */
export const discard = mutation({
  args: { sheetId: v.id("talkSheets") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { sheet } = await ownDraft(ctx, args.sheetId);
    for (const item of await sheetItems(ctx, sheet._id))
      await ctx.db.delete(item._id);
    await ctx.db.delete(sheet._id);
    return null;
  },
});

const gapRow = v.object({ code: v.string(), label: v.string() });

const itemView = v.object({
  item: schema.doc("talkSheetItems"),
  effectiveStatus: talkSheetItemStatus,
  carried: v.boolean(),
  daysOpen: v.number(),
  rootCauseDue: v.boolean(),
});

function viewItem(item: Doc<"talkSheetItems">, asOf: string) {
  return {
    item,
    effectiveStatus: effectiveStatus(item, asOf),
    carried: item.carriedFromItemId !== undefined,
    daysOpen: Math.max(0, daysBetween(item.openedOn, asOf)),
    rootCauseDue: rootCauseDue(
      { status: effectiveStatus(item, asOf), openedOn: item.openedOn },
      asOf,
    ),
  };
}

/**
 * One sheet with its lines judged as of the meeting date. Read by its author or a
 * supervisor whose scope holds the sheet's unit.
 */
export const detail = query({
  args: { sheetId: v.id("talkSheets") },
  returns: v.object({
    sheet: schema.doc("talkSheets"),
    ownerName: v.string(),
    previousMeetingDate: v.union(v.string(), v.null()),
    items: v.array(itemView),
    gaps: v.array(gapRow),
    canEdit: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { profile } = await requireCapability(ctx, "visit.read");
    const sheet = await ctx.db.get(args.sheetId);
    if (!sheet) throw new ConvexError("Talk Sheet not found");
    if (sheet.ownerProfileId !== profile._id) {
      await requireCapability(ctx, "people.read", sheet.orgUnitId);
      await requireCapability(ctx, "visit.read", sheet.orgUnitId);
    }
    const items = await sheetItems(ctx, sheet._id);
    const previous = sheet.previousSheetId
      ? await ctx.db.get(sheet.previousSheetId)
      : null;
    const gaps =
      sheet.status === "draft" ? finalizeGaps({ ...sheet, items }) : [];
    return {
      sheet,
      ownerName:
        (await ctx.db.get(sheet.ownerProfileId))?.name ?? "Former user",
      previousMeetingDate: previous?.meetingDate ?? null,
      items: items.map((item) => viewItem(item, sheet.meetingDate)),
      gaps: gaps.map((code) => ({ code, label: GAP_LABELS[code] })),
      canEdit: sheet.status === "draft" && sheet.ownerProfileId === profile._id,
    };
  },
});

const sheetRow = v.object({
  sheetId: v.id("talkSheets"),
  partnerName: v.string(),
  meetingDate: v.string(),
  nextContactDate: v.union(v.string(), v.null()),
  status: v.string(),
  carriedFrom: v.union(v.string(), v.null()),
});

/** The caller's own Talk Sheets, newest first, and the partner names they already use. */
export const mine = query({
  args: {},
  returns: v.object({
    sheets: v.array(sheetRow),
    partners: v.array(v.string()),
  }),
  handler: async (ctx) => {
    const { profile } = await requireCapability(ctx, "visit.record");
    const sheets = await ctx.db
      .query("talkSheets")
      .withIndex("by_ownerProfileId_and_meetingDate", (q) =>
        q.eq("ownerProfileId", profile._id),
      )
      .order("desc")
      .take(MAX_MINE);
    const previousDates = new Map<string, string | null>();
    const rows = [];
    for (const sheet of sheets) {
      let carriedFrom: string | null = null;
      if (sheet.previousSheetId) {
        if (!previousDates.has(sheet.previousSheetId))
          previousDates.set(
            sheet.previousSheetId,
            (await ctx.db.get(sheet.previousSheetId))?.meetingDate ?? null,
          );
        carriedFrom = previousDates.get(sheet.previousSheetId) ?? null;
      }
      rows.push({
        sheetId: sheet._id,
        partnerName: sheet.partnerName,
        meetingDate: sheet.meetingDate,
        nextContactDate: sheet.nextContactDate ?? null,
        status: sheet.status,
        carriedFrom,
      });
    }
    const partners = [
      ...new Set(sheets.map((sheet) => sheet.partnerName)),
    ].sort((a, b) => a.localeCompare(b));
    return { sheets: rows, partners };
  },
});

const openItemRow = v.object({
  itemId: v.id("talkSheetItems"),
  sheetId: v.id("talkSheets"),
  partnerName: v.string(),
  ownerName: v.string(),
  topic: talkSheetTopic,
  gap: v.string(),
  responsible: v.string(),
  timeline: v.string(),
  status: talkSheetItemStatus,
  openedOn: v.string(),
  daysOpen: v.number(),
  rootCauseDue: v.boolean(),
  rootCause: v.union(v.string(), v.null()),
});

/**
 * Supervisor register: every partner chain in scope with its latest signed sheet, the open
 * lines that will carry to the next sheet (judged as of today), overdue lines, lines open
 * over a month (root-cause re-review) and missed next-contact dates.
 */
export const register = query({
  args: supervisionArgs,
  returns: v.object({
    today: v.string(),
    truncated: v.boolean(),
    chains: v.array(
      v.object({
        latestSheetId: v.id("talkSheets"),
        partnerName: v.string(),
        orgUnitId: v.id("orgUnits"),
        unitName: v.string(),
        ownerName: v.string(),
        lastMeetingDate: v.union(v.string(), v.null()),
        nextContactDate: v.union(v.string(), v.null()),
        contactOverdue: v.boolean(),
        draftSheetId: v.union(v.id("talkSheets"), v.null()),
        openCount: v.number(),
        overdueCount: v.number(),
        rootCauseCount: v.number(),
      }),
    ),
    openItems: v.array(openItemRow),
  }),
  handler: async (ctx, args) => {
    const sc = await supervisorContext(ctx, args);
    const today = manilaDate(Date.now());
    const unitNames = new Map(
      sc.unitOptions.map((unit) => [unit.id, unit.name]),
    );
    const names = new Map<Id<"profiles">, string>();
    const name = async (id: Id<"profiles">) => {
      if (!names.has(id))
        names.set(id, (await ctx.db.get(id))?.name ?? "Former user");
      return names.get(id)!;
    };
    let truncated = false;
    let read = 0;
    // Latest draft and latest final per unit+partner, newest first.
    const chains = new Map<
      string,
      { draft?: Doc<"talkSheets">; final?: Doc<"talkSheets"> }
    >();
    for (const unitId of sc.units) {
      if (read >= MAX_SHEETS) {
        truncated = true;
        break;
      }
      const sheets = await ctx.db
        .query("talkSheets")
        .withIndex("by_orgUnitId_and_meetingDate", (q) =>
          q.eq("orgUnitId", unitId),
        )
        .order("desc")
        .take(MAX_SHEETS - read + 1);
      if (sheets.length > MAX_SHEETS - read) {
        truncated = true;
        sheets.length = MAX_SHEETS - read;
      }
      read += sheets.length;
      for (const sheet of sheets) {
        const key = `${sheet.orgUnitId}|${sheet.partnerKey}`;
        const chain = chains.get(key) ?? {};
        if (sheet.status === "draft") chain.draft ??= sheet;
        else chain.final ??= sheet;
        chains.set(key, chain);
      }
    }
    const rows = [];
    const openItems = [];
    for (const { draft, final } of chains.values()) {
      const latest = (final ?? draft)!;
      let openCount = 0;
      let overdueCount = 0;
      let rootCauseCount = 0;
      if (final) {
        for (const item of await sheetItems(ctx, final._id)) {
          const view = viewItem(item, today);
          if (!carriesOver(view.effectiveStatus)) continue;
          openCount++;
          if (view.effectiveStatus === "overdue") overdueCount++;
          if (view.rootCauseDue) rootCauseCount++;
          openItems.push({
            itemId: item._id,
            sheetId: final._id,
            partnerName: final.partnerName,
            ownerName: await name(final.ownerProfileId),
            topic: item.topic,
            gap: item.gap,
            responsible: item.responsible,
            timeline: item.timeline,
            status: view.effectiveStatus,
            openedOn: item.openedOn,
            daysOpen: view.daysOpen,
            rootCauseDue: view.rootCauseDue,
            rootCause: item.rootCause ?? null,
          });
        }
      }
      const nextContactDate = final?.nextContactDate ?? null;
      rows.push({
        latestSheetId: latest._id,
        partnerName: latest.partnerName,
        orgUnitId: latest.orgUnitId,
        unitName: unitNames.get(latest.orgUnitId) ?? "",
        ownerName: await name(latest.ownerProfileId),
        lastMeetingDate: final?.meetingDate ?? null,
        nextContactDate,
        contactOverdue:
          nextContactDate !== null && nextContactDate < today && !draft,
        draftSheetId: draft?._id ?? null,
        openCount,
        overdueCount,
        rootCauseCount,
      });
    }
    rows.sort((a, b) => a.partnerName.localeCompare(b.partnerName));
    openItems.sort(
      (a, b) =>
        Number(b.rootCauseDue) - Number(a.rootCauseDue) ||
        Number(b.status === "overdue") - Number(a.status === "overdue") ||
        a.openedOn.localeCompare(b.openedOn),
    );
    return { today, truncated, chains: rows, openItems };
  },
});
