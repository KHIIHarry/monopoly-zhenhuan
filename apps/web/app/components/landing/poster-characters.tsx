import Image from 'next/image';

export function PosterCharacters() {
  return <div className="landing-layer landing-characters" data-testid="landing-characters" aria-hidden="true">
    <Image src="/assets/landing/characters.png" width={620} height={250} alt="" priority />
  </div>;
}
