import Image from 'next/image';

export function PosterFrame() {
  return <div className="landing-layer landing-frame" data-testid="landing-frame" aria-hidden="true">
    <Image src="/assets/landing/gold-frame.png" width={300} height={300} alt="" priority />
  </div>;
}
