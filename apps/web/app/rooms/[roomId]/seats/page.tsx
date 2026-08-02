import AppRouterClient from '../../../components/app-router-client';

export default async function SeatsPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { roomId } = await params;
  const { returnTo: requestedReturn } = await searchParams;
  const seatsReturnView = requestedReturn === 'player' || requestedReturn === 'bank'
    ? requestedReturn
    : undefined;
  return <AppRouterClient page="seats" roomId={roomId} seatsReturnView={seatsReturnView} />;
}
