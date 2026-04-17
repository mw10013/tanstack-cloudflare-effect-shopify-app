import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/app/")({
  component: AppIndex,
});

function AppIndex() {
  const { shop } = Route.useRouteContext();
  return (
    <s-page heading="Shopify app">
      <s-section heading="Connected">
        <s-paragraph>
          App is installed and running for <s-text fontWeight="bold">{shop}</s-text>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
