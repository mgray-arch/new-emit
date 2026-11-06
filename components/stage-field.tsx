import { STATUS_LABEL, type CustomerOrder } from "@/lib/types";

/** The stage is changed on Edit load, where Save stores it. This page only shows it. */
export default function StageField({ order, canEdit }: { order: CustomerOrder; canEdit?: boolean }) {
  return (
    <div className="field stage-field">
      <span>Stage</span>
      <strong>{STATUS_LABEL[order.portalStatus]}</strong>
      {canEdit ? <p className="mini">Change the stage from Edit load. Saving that form saves the stage.</p> : null}
    </div>
  );
}
