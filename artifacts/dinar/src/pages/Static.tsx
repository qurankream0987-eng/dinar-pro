import { Compass, Home } from "lucide-react";
import { ButtonLink } from "@/ui/Button";
import { PageHeader } from "@/ui/Layout";

export function NotFoundPage() {
  return (
    <div className="container-app flex min-h-[60vh] flex-col items-center justify-center py-12 text-center">
      <p className="num text-7xl font-bold text-primary/15">404</p>
      <h1 className="mt-2 text-2xl font-bold">هذه الصفحة غير موجودة</h1>
      <p className="mt-2 max-w-sm text-base text-muted-foreground">ربما تغيّر الرابط. السوق ما زال هنا.</p>
      <div className="mt-6 flex gap-2">
        <ButtonLink href="/" icon={<Home size={17} />} data-testid="link-not-found-home">
          الرئيسية
        </ButtonLink>
        <ButtonLink href="/search" variant="secondary" icon={<Compass size={17} />}>
          استكشف
        </ButtonLink>
      </div>
    </div>
  );
}
