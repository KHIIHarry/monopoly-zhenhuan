'use client';

export function LandingPoster({ onJoin }: { onJoin: () => void }) {
  return <main className="landing-page">
    <div className="landing-lantern landing-lantern-left" aria-hidden="true"><span>宫</span></div>
    <div className="landing-lantern landing-lantern-right" aria-hidden="true"><span>宴</span></div>

    <section className="landing-poster" data-testid="landing-poster" aria-label="甄嬛传大富翁">
      <div className="landing-dice" aria-hidden="true"><i /><i /><i /><i /></div>
      <div className="landing-palace-mark" aria-hidden="true"><i /><i /><i /></div>
      <p className="landing-eyebrow">紫禁深宫 · 风云棋局</p>
      <h1>甄嬛传</h1>
      <p className="landing-subtitle">大富翁</p>

      <div className="landing-join-panel">
        <p className="landing-fate-line">骰子落下 · 命运重生 · 娘娘出发</p>
        <button className="landing-join-button" data-testid="landing-join-button" type="button" onClick={onJoin}>加入游戏组</button>
        <p className="landing-hint">今夜入局，执掌你的宫廷命运</p>
      </div>
    </section>
    <div className="landing-seal" aria-hidden="true">入局有礼</div>
  </main>;
}
