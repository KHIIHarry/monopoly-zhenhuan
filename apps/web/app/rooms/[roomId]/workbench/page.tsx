import AppRouterClient from '../../../components/app-router-client';

export default async function WorkbenchSelectorPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <AppRouterClient page="workbench" roomId={roomId} />;
}
