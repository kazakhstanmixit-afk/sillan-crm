import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

// ширина по умолчанию — вся строка, если ширину не задали явно (w-auto, w-48 и т.п.)
const width = (className?: string) => (/(^|\s)(w-|max-w-)/.test(className ?? '') ? '' : 'w-full')

const control =
  'rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100 disabled:text-slate-500 aria-[invalid=true]:border-rose-400'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(control, width(className), 'h-9', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(control, width(className), 'py-2', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(control, width(className), 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  )
})

export function Field({ label, error, hint, required, children, className }: {
  label: ReactNode
  error?: string
  hint?: ReactNode
  required?: boolean
  children: (id: string) => ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </label>
      {children(id)}
      {error ? <p className="text-xs text-rose-600" role="alert">{error}</p> : hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  )
}

export function Checkbox({ label, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode }) {
  return (
    <label className={cn('inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700', className)}>
      <input type="checkbox" className="size-4 rounded border-slate-300 text-brand-600 accent-brand-700" {...rest} />
      {label}
    </label>
  )
}

/** Выбор нескольких значений «плашками» (направления, услуги) */
export function ChipSelect<T extends string>({ options, value, onChange, disabled }: {
  options: { value: T; label: string }[]
  value: T[]
  onChange: (v: T[]) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={cn(
              'rounded-full border px-3 py-1 text-[13px] transition-colors',
              on ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-brand-300',
              disabled && 'opacity-60',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
