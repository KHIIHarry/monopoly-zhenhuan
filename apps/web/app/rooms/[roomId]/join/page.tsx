import AppRouterClient from '../../../components/app-router-client';

export default async function JoinRoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <AppRouterClient page="join-room" roomId={roomId} />;
}
