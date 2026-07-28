import AppRouterClient from '../../../components/app-router-client';

export default async function SettlementPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <AppRouterClient page="settlement" roomId={roomId} />;
}
