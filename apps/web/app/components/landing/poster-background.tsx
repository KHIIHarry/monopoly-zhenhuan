import Image from 'next/image';

export function PosterBackground() {
  return <div className="landing-layer landing-background" data-testid="landing-background">
    <Image src="/assets/landing/palace-sky.png" width={256} height={305} alt="" priority />
  </div>;
}
