import AppRouterClient from '../../../components/app-router-client';

export default async function PlayerPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <AppRouterClient page="player" roomId={roomId} />;
}
