import React from 'react';

interface Props {
  isOpen: boolean;
  type: 'offer' | 'decision';
  onConfirm: () => void;
  onReject?: () => void;
  isProcessing?: boolean;
}

export function CubeModal({ isOpen, type, onConfirm, onReject, isProcessing }: Props) {
  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.8)', zIndex: 100
    }}>
      <div style={{
        background: 'var(--cg-bg-1)', padding: '24px', borderRadius: '12px',
        border: '1px solid var(--cg-border)', maxWidth: '400px', width: '100%',
        textAlign: 'center'
      }}>
        <h2 style={{ fontSize: '24px', marginBottom: '16px', color: 'var(--cg-brass)' }}>
          {type === 'offer' ? 'Offer Double?' : 'Double Offered!'}
        </h2>

        <p style={{ color: 'var(--cg-text)', marginBottom: '24px' }}>
          {type === 'offer'
            ? 'Are you sure you want to offer a double? This will require you to deposit additional funds into the match escrow.'
            : 'Your opponent has offered a double. Do you accept the double and deposit additional funds, or drop and forfeit this game?'}
        </p>

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
          {type === 'offer' ? (
            <>
              <button
                onClick={onReject}
                disabled={isProcessing}
                style={{ padding: '8px 16px', background: 'var(--cg-bg-2)', color: 'var(--cg-text)', borderRadius: '6px' }}>
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={isProcessing}
                style={{ padding: '8px 16px', background: 'var(--cg-brass)', color: 'var(--cg-bg-0)', borderRadius: '6px', fontWeight: 'bold' }}>
                {isProcessing ? 'Processing...' : 'Offer Double'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onReject}
                disabled={isProcessing}
                style={{ padding: '8px 16px', background: 'var(--cg-danger)', color: 'white', borderRadius: '6px', fontWeight: 'bold' }}>
                Drop (Forfeit Game)
              </button>
              <button
                onClick={onConfirm}
                disabled={isProcessing}
                style={{ padding: '8px 16px', background: 'var(--cg-brass)', color: 'var(--cg-bg-0)', borderRadius: '6px', fontWeight: 'bold' }}>
                {isProcessing ? 'Processing...' : 'Take (Deposit)'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
