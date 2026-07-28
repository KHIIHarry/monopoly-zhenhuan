'use client';

import Image from 'next/image';

export function PosterJoinButton({ onJoin }: { onJoin: () => void }) {
  return <button className="landing-join-button" data-testid="landing-join-button" type="button" onClick={onJoin}>
    <Image src="/assets/landing/join-button.png" width={300} height={100} alt="加入游戏组" priority />
  </button>;
}
