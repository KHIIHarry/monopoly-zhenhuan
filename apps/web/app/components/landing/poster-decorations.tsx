import Image from 'next/image';

export function PosterDecorations() {
  return <div className="landing-layer landing-decorations" data-testid="landing-decorations" aria-hidden="true">
    <Image src="/assets/landing/foreground-flora.png" width={310} height={300} alt="" priority />
  </div>;
}
