/** Read-only. This does not call SAM or the Load Builder. */
export default function BuildStatus({ status }: { status?: string | null }) {
  if (!status) return null;
  const built = status.startsWith("Built in SAM:");
  return (
    <span className="build-status" data-build-status={built ? "built" : "sent"}>
      {status}
    </span>
  );
}
