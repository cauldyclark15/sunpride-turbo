"use client";

import { PageHeader, WorkspaceModuleTabs } from "@sunpride/ui";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import {
  OPERATIONS_SECTIONS,
  activeTabHref,
  operationsSectionFor,
  operationsSubFor,
  slugOf,
  visibleOperationsSubs,
  type OperationsSection,
} from "@/config/navigation";
import { useSession } from "@/lib/auth/session";
import { canAccessWebModule } from "@/lib/module-access";
import { ReceiptsScreen } from "./receipts";
import { StoreDayScreens } from "../storepos/store-day-screens";
import { OverridesScreen } from "../storepos/overrides-review";
import { TillDaysScreen, ZHistoryScreen } from "../storepos/till-days";
import { TaxPeriodSummaryScreen } from "../fiscal/tax-period-summary";
import { PanelErrorBoundary } from "../panel-error-boundary";
import { CountReviewScreen, CountScreen, MyCounts, PlanCount } from "./counts";
import { pickCountPhoto } from "./count-photo";
import { DecideInbox } from "./decide";
import {
  LoadsPicker,
  ReviewList,
  StockCardPicker,
  manilaToday,
  manilaTomorrow,
} from "./operations-pickers";
import { ReceiveDelivery, ReceiveQueue } from "./receive";
import { BadOrders, ExpiryBoard, StockCard, StockOnHand } from "./stock";
import { TransferDetail, TransfersList } from "./transfers";
import { PlannedLoad, RosterEditor, VanDayBoard } from "./vanday";

/** Where a stock-card row's document opens (null = no screen for it yet). */
export function documentHref(link: { type: string; id: string }) {
  switch (link.type) {
    case "stock_transfer":
      return `/operations/transfers/${link.id}`;
    case "stock_count":
      return `/operations/counts/review?session=${link.id}`;
    case "disposition":
      return "/operations/stock/bad-orders";
    default:
      return null;
  }
}

/** Who may plan a count (inventory.count.submit): the others only count or review. */
const COUNT_PLANNERS = new Set(["super_admin", "admin", "operations", "manager"]);

const SubTabs = ({
  section,
  pathname,
  role,
}: {
  section: OperationsSection;
  pathname: string;
  role: string;
}) => {
  const subs = visibleOperationsSubs(section, (slug) =>
    canAccessWebModule(slug, role),
  ).filter((sub) => sub.id !== "plan" || COUNT_PLANNERS.has(role));
  const current = operationsSubFor(pathname);
  if (subs.length < 2) return null;
  return (
    <nav aria-label={`${section.label} screens`} className="flex flex-wrap gap-2">
      {subs.map((sub) => (
        <Link
          key={sub.id}
          href={sub.href}
          aria-current={current?.id === sub.id ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded-full border px-4 text-base ${
            current?.id === sub.id
              ? "border-accent bg-accent-soft font-medium"
              : "border-border bg-surface"
          }`}
        >
          {sub.label}
        </Link>
      ))}
    </nav>
  );
};

/** The two rows of Operations: the verbs, then the screens of the verb. Also drawn above the older pages that live under a verb. */
export function OperationsTabs({ role }: { role: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const section = operationsSectionFor(pathname);
  const tabs = OPERATIONS_SECTIONS.map(({ id, label, href }) => ({
    id,
    label,
    href,
  })).filter((tab) => canAccessWebModule(slugOf(tab.href), role));
  return (
    <div className="grid gap-3">
      <WorkspaceModuleTabs
        activeHref={activeTabHref(pathname)}
        items={tabs}
        onNavigate={(href) => router.push(href)}
      />
      {section ? (
        <SubTabs section={section} pathname={pathname} role={role} />
      ) : null}
    </div>
  );
}

function Back({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 w-fit items-center text-base font-medium underline"
    >
      ← {children}
    </Link>
  );
}

/** The screen for `/operations/<section>/<screen>`. */
function Screen({ path, role }: { path: string[]; role: string }) {
  const router = useRouter();
  const query = useSearchParams();
  const [section = "stock", screen, extra] = path;
  const push = (href: string) => router.push(href);
  const canPlan = COUNT_PLANNERS.has(role);
  switch (section) {
    case "stock":
      if (!screen)
        return (
          <StockOnHand
            cardHref={(p, l) =>
              `/operations/stock/card?product=${p}&location=${l}`
            }
          />
        );
      if (screen === "card") {
        const product = query.get("product"),
          location = query.get("location");
        return product && location ? (
          <StockCard
            productId={product}
            locationId={location}
            documentHref={documentHref}
          />
        ) : (
          <StockCardPicker
            onPick={(p, l) =>
              push(`/operations/stock/card?product=${p}&location=${l}`)
            }
          />
        );
      }
      if (screen === "bad-orders") return <BadOrders />;
      if (screen === "expiry") return <ExpiryBoard />;
      break;
    case "receive":
      if (!screen)
        return (
          <ReceiveQueue
            onOpenTransfer={(id) => push(`/operations/transfers/${id}`)}
            onOpenLoadIn={(tripId) => push(`/van-trips?tripId=${tripId}`)}
            onUnplanned={() => push("/operations/receive/delivery")}
          />
        );
      if (screen === "delivery")
        return (
          <ReceiveDelivery onPosted={() => push("/operations/receive")} />
        );
      break;
    case "transfers":
      if (!screen)
        return <TransfersList onOpen={(id) => push(`/operations/transfers/${id}`)} />;
      return (
        <div className="grid gap-3">
          <Back href="/operations/transfers">All transfers</Back>
          <TransferDetail transferId={screen} />
        </div>
      );
    case "counts": {
      const session = query.get("session");
      if (!screen)
        return (
          <MyCounts
            onOpen={(id) => push(`/operations/counts/count?session=${id}`)}
            onReview={(id) => push(`/operations/counts/review?session=${id}`)}
            onPlan={canPlan ? () => push("/operations/counts/plan") : undefined}
          />
        );
      if (screen === "plan")
        return <PlanCount onPlanned={() => push("/operations/counts")} />;
      if (screen === "review")
        return session ? (
          <div className="grid gap-3">
            <Back href="/operations/counts/review">Counts to review</Back>
            <CountReviewScreen
              sessionId={session}
              onApproved={() => push("/operations/counts/review")}
            />
          </div>
        ) : (
          <ReviewList
            hrefFor={(id) => `/operations/counts/review?session=${id}`}
          />
        );
      if (screen === "count" && session)
        return (
          <div className="grid gap-3">
            <Back href="/operations/counts">My counts</Back>
            <CountScreen
              sessionId={session}
              deviceLabel="Web"
              onPickPhoto={() => pickCountPhoto(session)}
              onFinished={() => push("/operations/counts")}
            />
          </div>
        );
      break;
    }
    case "van-day": {
      const today = manilaToday();
      if (!screen)
        return (
          <VanDayBoard
            date={today}
            onOpen={(what, row) => {
              if (what === "decide") push("/operations/decide");
              else if (what === "trip" && row.tripId)
                push(`/van-trips?tripId=${row.tripId}`);
              else if (row.tripId)
                push(`/operations/van-day/loads?trip=${row.tripId}`);
            }}
          />
        );
      if (screen === "roster") return <RosterEditor today={today} />;
      if (screen === "loads") {
        const trip = query.get("trip");
        return trip ? (
          <div className="grid gap-3">
            <Back href="/operations/van-day/loads">All suggested loads</Back>
            <PlannedLoad
              tripId={trip}
              onDone={() => push("/operations/van-day")}
            />
          </div>
        ) : (
          <LoadsPicker
            dates={[today, manilaTomorrow()]}
            hrefFor={(id) => `/operations/van-day/loads?trip=${id}`}
          />
        );
      }
      break;
    }
    case "stores-pos":
      if (!screen) return <TillDaysScreen />;
      if (screen === "z") return <ZHistoryScreen />;
      if (screen === "overrides") return <OverridesScreen />;
      if (screen === "receipts") return <ReceiptsScreen />;
      if (screen === "tax") return <TaxPeriodSummaryScreen />;
      if (screen === "all") return <StoreDayScreens />;
      break;
    case "decide":
      if (!screen) return <DecideInbox />;
      break;
  }
  void extra;
  return (
    <section className="rounded-lg border border-border bg-surface p-8">
      <h1 className="text-xl font-semibold">That screen does not exist</h1>
      <p className="mt-2 text-base text-muted">
        Pick one of the tabs above.
      </p>
    </section>
  );
}

/** The first verb a role may open (for `/operations` on its own). */
export function firstOperationsHref(role: string) {
  return (
    OPERATIONS_SECTIONS.find((s) => canAccessWebModule(s.access, role))?.href ??
    null
  );
}

/** `/operations/**`: the verbs-first Operations workspace. */
export function OperationsWorkspace({ path }: { path: string[] }) {
  const { profile } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const first = path[0] ?? "";
  const known = OPERATIONS_SECTIONS.some((s) => s.id === first);
  const role = profile?.role ?? "";
  const target = profile && !first ? firstOperationsHref(role) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);
  if (!profile)
    return <div className="text-[13px] text-muted">Checking access…</div>;
  if (!first) return <div className="text-[13px] text-muted">Opening…</div>;
  const denied =
    !profile.active ||
    !known ||
    !canAccessWebModule(`ops-${first}`, role);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <PageHeader title="Operations" />
      <OperationsTabs role={role} />
      {denied ? (
        <section className="rounded-lg border border-border bg-surface p-8">
          <h1 className="text-xl font-semibold">
            {known ? "Access denied" : "That page does not exist"}
          </h1>
          <p className="mt-2 text-base text-muted">
            {known
              ? "Your role cannot open this page. Ask an administrator for access."
              : "Pick one of the tabs above."}
          </p>
        </section>
      ) : (
        <PanelErrorBoundary label="This screen" key={pathname}>
          <Screen path={path} role={role} />
        </PanelErrorBoundary>
      )}
    </div>
  );
}
