import React from 'react';

interface FlightChipButtonProps {
  id: string;
  onSelect: (id: string) => void;
  variant?: 'default' | 'breach' | 'delayed' | 'recovery' | 'ontime';
  title?: string;
}

const VARIANT_CLASSES: Record<NonNullable<FlightChipButtonProps['variant']>, string> = {
  default: 'border-[#14130F] bg-[#F6F2E8] text-[#14130F] hover:bg-[#14130F] hover:text-[#F6F2E8]',
  breach: 'border-[#C8341C] bg-[#F6F2E8] text-[#C8341C] hover:bg-[#C8341C] hover:text-[#F6F2E8]',
  delayed: 'border-[#C98A0B] bg-[#F6F2E8] text-[#8A5D00] hover:bg-[#C98A0B] hover:text-[#14130F]',
  recovery: 'border-[#1D4E89] bg-[#F6F2E8] text-[#1D4E89] hover:bg-[#1D4E89] hover:text-[#F6F2E8]',
  ontime: 'border-[#2F6B4F] bg-[#F6F2E8] text-[#2F6B4F] hover:bg-[#2F6B4F] hover:text-[#F6F2E8]',
};

export const FlightChipButton: React.FC<FlightChipButtonProps> = ({
  id,
  onSelect,
  variant = 'default',
  title,
}) => {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      title={title ?? `Inspect ${id}`}
      className={`inline-flex items-center px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums border rounded-[2px] cursor-pointer transition-colors ${VARIANT_CLASSES[variant]}`}
    >
      {id}
    </button>
  );
};
