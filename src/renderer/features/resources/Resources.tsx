import { useResource } from "./use-resource.js";

export function Resources() {
  const resource = useResource();
  const acquired = resource.lease.status === "ready";
  const transferring = resource.transfer.status === "running";
  return (
    <div className="experiment-grid" id="panel-resources">
      <div className="experiment-content">
        <h3>A worker resource, held by a React scope.</h3>
        <p>
          Opening this tab acquires a handle. Stream bytes, release it, or replace it with a new
          resource. Leaving closes its scope and connection.
        </p>
        <div className="experiment-actions">
          <button
            data-acquire-resource
            disabled={resource.lease.status === "loading" || resource.lease.status === "releasing"}
            onClick={resource.reload}
          >
            {acquired ? "Replace resource" : "Acquire resource"}
          </button>
          <button
            data-read-resource
            disabled={!acquired || transferring}
            onClick={resource.transfer.run}
          >
            Stream 32 MiB
          </button>
          <button data-cancel-transfer disabled={!transferring} onClick={resource.transfer.cancel}>
            Cancel transfer
          </button>
          <button data-release-resource disabled={!acquired} onClick={resource.release}>
            Release resource
          </button>
        </div>
        <output data-resource-state={resource.lease.status} aria-live="polite">
          {resource.resourceMessage}
        </output>
        <output className="resource-transfer" data-transfer-state aria-live="polite">
          {resource.transferMessage}
        </output>
      </div>
      <aside className="scope-summary">
        <div className="lease-value" data-received-bytes={resource.received}>
          <strong>{(resource.received / 1024 / 1024).toFixed(1)}</strong>
          <span>MiB received</span>
        </div>
        <progress aria-label="Bytes received" value={resource.received} max={32 * 1024 * 1024} />
        <small>
          Bytes are generated in a dedicated worker. The resource survives a cancelled transfer.
        </small>
      </aside>
    </div>
  );
}
