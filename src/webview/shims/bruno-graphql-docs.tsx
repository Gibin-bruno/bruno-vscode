/**
 * Shim for @usebruno/graphql-docs
 * Provides a placeholder component for GraphQL documentation
 */

import React, { forwardRef, useImperativeHandle } from 'react';

interface DocExplorerProps {
  schema?: any;
  onClickType?: (type: any) => void;
  onClickField?: (field: any) => void;
  children?: React.ReactNode;
}

export interface DocExplorerHandle {
  showDocForReference: (reference: any) => void;
}

/**
 * GraphQL Documentation Explorer component
 * This is a placeholder - the full implementation would require the graphql-docs package
 */
export const DocExplorer = forwardRef<DocExplorerHandle, DocExplorerProps>(({ schema }, ref) => {
  // Same handle as the real graphql-docs DocExplorer; the placeholder has no per-type docs to navigate to
  useImperativeHandle(ref, () => ({
    showDocForReference: () => {}
  }), []);

  if (!schema) {
    return (
      <div style={{ padding: '16px', color: '#666' }}>
        No GraphQL schema available. Run a query to load the schema.
      </div>
    );
  }

  return (
    <div style={{ padding: '16px' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', fontWeight: 600 }}>
        GraphQL Schema Documentation
      </h3>
      <p style={{ color: '#666', fontSize: '13px', margin: 0 }}>
        GraphQL documentation explorer is available in the desktop app.
        Use the GraphiQL interface below for introspection and documentation.
      </p>
    </div>
  );
});

export default DocExplorer;
