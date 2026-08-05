import { LoaderCircle } from "lucide-react";
import styles from "./route-skeleton.module.css";

export type RouteSkeletonVariant =
  | "rooms"
  | "player"
  | "bank"
  | "workbench"
  | "loader";

function Block({
  className = "",
  region,
}: {
  className?: string;
  region?: string;
}) {
  return (
    <span className={`${styles.block} ${className}`} data-region={region} />
  );
}

function RedHeader({ region }: { region: string }) {
  return (
    <header className={styles.redHeader} data-region={region}>
      <Block className={styles.onRedTitle} />
      <Block className={styles.onRedTools} />
    </header>
  );
}

function WorkbenchNavigation({ bank = false }: { bank?: boolean }) {
  return (
    <aside className={styles.sideNav} data-region="workbench-nav">
      <Block className={styles.sideIdentity} />
      <Block
        className={`${styles.sideActions} ${bank ? styles.sideActionsTall : ""}`}
      />
      <Block className={styles.sideExit} />
    </aside>
  );
}

function RoomsSkeleton() {
  return (
    <div className={styles.rooms} aria-hidden="true">
      <header className={styles.roomsHeader} data-region="room-header">
        <Block className={styles.roomsAccount} />
        <Block className={styles.roomsTools} />
      </header>
      <div className={styles.roomList} data-region="room-list">
        <section className={styles.roomGroup}>
          <span className={styles.sectionLabel} />
          <Block className={styles.roomPrimary} />
        </section>
        <section className={styles.roomGroup}>
          <span className={styles.sectionLabel} />
          <Block className={styles.roomRow} />
        </section>
        <section className={styles.roomGroup}>
          <span className={styles.sectionLabel} />
          <Block className={styles.roomRow} />
        </section>
      </div>
    </div>
  );
}

function PlayerSkeleton() {
  return (
    <div className={styles.workbench} aria-hidden="true">
      <WorkbenchNavigation />
      <div className={styles.workbenchContent}>
        <RedHeader region="player-header" />
        <section className={styles.playerIdentity} data-region="player-identity">
          <Block />
          <Block />
        </section>
        <section className={styles.turnStrip} data-region="turn">
          <Block />
        </section>
        <div className={styles.playerBody}>
          <Block className={styles.diceRegion} />
          <Block className={styles.playerActions} region="player-actions" />
          <span className={styles.propertyLabel} />
          <Block className={styles.propertyRegion} region="properties" />
        </div>
        <nav className={styles.mobileNav} data-region="mobile-nav"></nav>
      </div>
    </div>
  );
}

function BankSkeleton() {
  return (
    <div className={styles.workbench} aria-hidden="true">
      <WorkbenchNavigation bank />
      <div className={styles.workbenchContent}>
        <RedHeader region="bank-header" />
        <section className={styles.bankSummary} data-region="bank-summary">
          <Block className={styles.threeColumns} />
        </section>
        <div className={styles.bankBody}>
          <Block className={styles.currentTurn} region="turn" />
          <span className={styles.overviewLabel} />
          <Block
            className={styles.playerOverview}
            region="player-overview"
          />
          <span className={styles.approvalLabel} />
          <Block className={styles.approvalRegion} region="approvals" />
        </div>
        <nav className={styles.mobileNav} data-region="mobile-nav"></nav>
      </div>
    </div>
  );
}

function WorkbenchSelectorSkeleton() {
  return (
    <div className={styles.selector} aria-hidden="true">
      <div className={styles.selectorContent}>
        <section className={styles.selectorHeading} data-region="selector-heading">
          <Block className={styles.selectorMark} />
          <Block className={styles.selectorTitle} />
          <Block className={styles.selectorCopy} />
        </section>
        <Block
          className={styles.identityChoices}
          region="identity-choices"
        />
        <section className={styles.selectorCommands} data-region="selector-commands">
          <Block />
          <Block />
        </section>
        <span className={styles.selectorFoot} />
      </div>
    </div>
  );
}

function GenericLoader() {
  return (
    <main
      className={styles.loader}
      data-testid="route-loader"
      data-variant="loader"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <LoaderCircle className={styles.loaderIcon} aria-hidden="true" />
      <span className={styles.loaderText}>加载中...</span>
    </main>
  );
}

export default function RouteSkeleton({
  variant = "loader",
}: {
  variant?: RouteSkeletonVariant;
}) {
  if (variant === "loader") return <GenericLoader />;

  return (
    <main
      className={styles.skeleton}
      data-testid="route-skeleton"
      data-variant={variant}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className={styles.srOnly}>页面加载中</span>
      {variant === "rooms" ? <RoomsSkeleton /> : null}
      {variant === "player" ? <PlayerSkeleton /> : null}
      {variant === "bank" ? <BankSkeleton /> : null}
      {variant === "workbench" ? <WorkbenchSelectorSkeleton /> : null}
    </main>
  );
}
