import AppRouterClient from '../../../components/app-router-client';

export default async function FinishRoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <AppRouterClient page="finish" roomId={roomId} />;
}
