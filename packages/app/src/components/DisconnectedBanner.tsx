import { BANNERS } from "../copy";
import styles from "./DisconnectedBanner.module.css";

// Copy and colors 1:1 from the mock's disconnected banner (shown under the
// TopBar only while conn state === "disconnected"). The "3s" is the mock's
// literal copy — the real retry cadence is the Rust backoff cap (4s); wiring
// a live countdown is not this banner's job.
export function DisconnectedBanner() {
  return (
    <div className={styles.banner}>
      {BANNERS.disconnectedLead}
      <span className={styles.dim}>{BANNERS.disconnectedDetail}</span>
    </div>
  );
}
