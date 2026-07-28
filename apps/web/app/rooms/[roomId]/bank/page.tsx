import AppRouterClient from '../../../components/app-router-client';

export default async function BankPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <AppRouterClient page="bank" roomId={roomId} />;
}
