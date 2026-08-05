import styles from "./route-skeleton.module.css";

export default function RouteSkeleton() {
  return (
    <main
      className={styles.page}
      data-testid="route-skeleton"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className={styles.srOnly}>页面加载中</span>
      <div className={styles.shell}>
        <header className={styles.header} aria-hidden="true">
          <span className={styles.avatar} aria-hidden="true" />
          <span className={styles.title} aria-hidden="true" />
          <span className={styles.amount} aria-hidden="true" />
        </header>
        <section className={styles.summary} aria-hidden="true">
          <span className={styles.heading} aria-hidden="true" />
          <span className={styles.action} aria-hidden="true" />
        </section>
        <section className={styles.list} aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <span className={styles.row} aria-hidden="true" key={index} />
          ))}
        </section>
      </div>
    </main>
  );
}
