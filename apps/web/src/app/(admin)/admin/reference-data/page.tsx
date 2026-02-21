import { redirect } from "next/navigation";

export default function AdminReferenceDataRedirectPage() {
  redirect("/admin?tab=configuration");
}
