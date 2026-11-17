-- Sillan CRM — 23. В отчёте дня — только торговые, у которых в этот день был план, визиты или заявки.

create or replace function app.daily_report_rows(p_date date)
returns table (
  manager_id uuid, full_name text,
  planned int, done int, failed int, found_pts int,
  i_high int, i_medium int, i_low int, i_none int,
  r_service int, r_parts int, r_equipment int, r_sum numeric
) language sql stable as $$
  with v as (
    select v.manager_id,
           count(*) filter (where v.planned_date = p_date and v.status in ('planned', 'done', 'failed')) planned,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date) done,
           count(*) filter (where v.planned_date = p_date and v.status = 'failed') failed,
           count(*) filter (where v.planned_date = p_date and v.purpose = 'Новая точка по пути') found_pts,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'high') i_high,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'medium') i_medium,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'low') i_low,
           count(*) filter (where v.status = 'done' and coalesce(app.local_date(v.actual_at), v.planned_date) = p_date and v.interest = 'none') i_none
      from public.visits v
     where v.planned_date between p_date - 31 and p_date + 1
     group by v.manager_id
  ), r as (
    select q.initiator_id manager_id,
           count(*) filter (where q.kind = 'service') r_service,
           count(*) filter (where q.kind = 'parts') r_parts,
           count(*) filter (where q.kind = 'equipment') r_equipment,
           coalesce(sum(q.budget), 0) r_sum
      from public.requests q
     where app.local_date(q.created_at) = p_date
     group by q.initiator_id
  )
  select p.id, p.full_name,
         coalesce(v.planned, 0)::int, coalesce(v.done, 0)::int, coalesce(v.failed, 0)::int, coalesce(v.found_pts, 0)::int,
         coalesce(v.i_high, 0)::int, coalesce(v.i_medium, 0)::int, coalesce(v.i_low, 0)::int, coalesce(v.i_none, 0)::int,
         coalesce(r.r_service, 0)::int, coalesce(r.r_parts, 0)::int, coalesce(r.r_equipment, 0)::int, coalesce(r.r_sum, 0)
    from public.profiles p
    left join v on v.manager_id = p.id
    left join r on r.manager_id = p.id
   where p.role = 'rep' and p.is_active
     and (coalesce(v.planned, 0) + coalesce(v.done, 0) + coalesce(r.r_service + r.r_parts + r.r_equipment, 0) > 0)
   order by p.full_name
$$;
