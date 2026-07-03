import { UserDetail } from "@/components/admin/user-detail";

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;
  return <UserDetail userId={userId} />;
}
