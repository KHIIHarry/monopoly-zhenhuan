import Image from 'next/image';

export function PosterTitle() {
  return <div className="landing-layer landing-title" data-testid="landing-title">
    <h1><Image src="/assets/landing/game-title.png" width={350} height={150} alt="甄嬛传大富翁" priority /></h1>
    <Image className="landing-subtitle" src="/assets/landing/game-subtitle.png" width={300} height={155} alt="大富翁" priority />
  </div>;
}
