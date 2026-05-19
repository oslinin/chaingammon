import React from 'react';

export function CubeTransactionOverlay({ isOpen, message }: { isOpen: boolean, message: string }) {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 1000, flexDirection: 'column', gap: '16px'
    }}>
      <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2" style={{ borderColor: 'var(--cg-brass)' }}></div>
      <p style={{ color: 'var(--cg-brass)', fontSize: '18px', fontWeight: 'bold' }}>{message}</p>
      <p style={{ color: 'var(--cg-text)', fontSize: '14px', maxWidth: '400px', textAlign: 'center' }}>
        Please approve the transaction in your wallet. Do not close this window.
      </p>
    </div>
  );
}
