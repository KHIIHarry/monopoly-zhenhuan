import AppRouterClient from '../../../components/app-router-client';

export default async function SeatsPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <AppRouterClient page="seats" roomId={roomId} />;
}
