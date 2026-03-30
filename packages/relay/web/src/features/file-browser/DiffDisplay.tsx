export function DiffDisplay({ diffContent }: { diffContent: string }) {
  const lines = diffContent.split('\n');

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      {lines.map((line, index) => {
        const isAdd = line.startsWith('+') && !line.startsWith('+++');
        const isRemove = line.startsWith('-') && !line.startsWith('---');
        const isHunk = line.startsWith('@@');
        const isHeader = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ');
        const className = [
          'whitespace-pre-wrap px-3 py-0.5 text-[11px] font-mono leading-5',
          isAdd ? 'bg-emerald-50 text-emerald-800' : '',
          isRemove ? 'bg-red-50 text-red-800' : '',
          isHunk ? 'bg-zinc-100 font-semibold text-zinc-600' : '',
          isHeader ? 'bg-zinc-50 font-semibold text-zinc-500' : ''
        ].join(' ');
        const style =
          isAdd ? { borderLeft: '2px solid rgb(16 185 129)' } : isRemove ? { borderLeft: '2px solid rgb(239 68 68)' } : undefined;

        return (
          <div key={`${index}:${line}`} className={className} style={style}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}
