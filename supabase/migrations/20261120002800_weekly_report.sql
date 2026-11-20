-- Sillan CRM — 28. Недельный отчёт торговых в Битрикс24.
-- Торговые без работы за неделю (0 визитов и 0 заявок) в отчёт не попадают —
-- в том числе уволенные, если за неделю они успели поработать, — их строка остаётся.

create or replace function app.weekly_report_rows(p_from date, p_to date)
returns table (
  manager_id uuid, full_name text, done int, work_days int, found_pts int,
  i_high int, i_medium int, i_low int, i_none int,
  seg_a int, seg_b int, seg_c int,
  r_service int, r_parts int, r_equipment int, r_sum numeric
) language sql stable as $$
  with v as (
    select v.manager_id,
           count(*) done,
           count(distinct app.local_date(v.actual_at)) work_days,
           count(*) filter (where v.purpose in ('Визит без плана', 'Новая точка по пути')) found_pts,
           count(*) filter (where v.interest = 'high') i_high,
           count(*) filter (where v.interest = 'medium') i_medium,
           count(*) filter (where v.interest = 'low') i_low,
           count(*) filter (where v.interest = 'none') i_none,
           count(*) filter (where l.segment = 'A') seg_a,
           count(*) filter (where l.segment = 'B') seg_b,
           count(*) filter (where l.segment = 'C') seg_c
      from public.visits v join public.locations l on l.id = v.location_id
     where v.status = 'done' and app.local_date(v.actual_at) between p_from and p_to
     group by v.manager_id
  ), r as (
    select q.initiator_id manager_id,
           count(*) filter (where q.kind = 'service') r_service,
           count(*) filter (where q.kind = 'parts') r_parts,
           count(*) filter (where q.kind = 'equipment') r_equipment,
           coalesce(sum(q.budget), 0) r_sum
      from public.requests q
     where app.local_date(q.created_at) between p_from and p_to
     group by q.initiator_id
  )
  select p.id, p.full_name,
         coalesce(v.done, 0)::int, coalesce(v.work_days, 0)::int, coalesce(v.found_pts, 0)::int,
         coalesce(v.i_high, 0)::int, coalesce(v.i_medium, 0)::int, coalesce(v.i_low, 0)::int, coalesce(v.i_none, 0)::int,
         coalesce(v.seg_a, 0)::int, coalesce(v.seg_b, 0)::int, coalesce(v.seg_c, 0)::int,
         coalesce(r.r_service, 0)::int, coalesce(r.r_parts, 0)::int, coalesce(r.r_equipment, 0)::int, coalesce(r.r_sum, 0)
    from public.profiles p
    left join v on v.manager_id = p.id
    left join r on r.manager_id = p.id
   where p.role = 'rep'
     and coalesce(v.done, 0) + coalesce(r.r_service + r.r_parts + r.r_equipment, 0) > 0
   order by coalesce(v.done, 0) desc, p.full_name
$$;

-- разбивка по дням: «Пн 16.11 — 15 точек (новых на месте 3), заявки: сервис 1»; дни без работы не пишутся
create or replace function app.weekly_report_days(p_manager uuid, p_from date, p_to date)
returns text language sql stable as $$
  with d as (select g::date d from generate_series(p_from, p_to, interval '1 day') g),
  v as (select app.local_date(v.actual_at) d, count(*) n,
               count(*) filter (where v.purpose in ('Визит без плана', 'Новая точка по пути')) found
          from public.visits v where v.manager_id = p_manager and v.status = 'done'
           and app.local_date(v.actual_at) between p_from and p_to group by 1),
  r as (select app.local_date(q.created_at) d,
               count(*) filter (where q.kind = 'service') s, count(*) filter (where q.kind = 'parts') p,
               count(*) filter (where q.kind = 'equipment') e
          from public.requests q where q.initiator_id = p_manager
           and app.local_date(q.created_at) between p_from and p_to group by 1)
  select string_agg(
           (array['Пн','Вт','Ср','Чт','Пт','Сб','Вс'])[extract(isodow from d.d)::int] || ' ' || to_char(d.d, 'DD.MM') || ' — '
           || coalesce(v.n, 0) || ' ' || case when coalesce(v.n,0) % 10 = 1 and coalesce(v.n,0) % 100 <> 11 then 'точка'
                when coalesce(v.n,0) % 10 between 2 and 4 and coalesce(v.n,0) % 100 not between 12 and 14 then 'точки' else 'точек' end
           || case when coalesce(v.found, 0) > 0 then ' (новых на месте ' || v.found || ')' else '' end
           || case when coalesce(r.s + r.p + r.e, 0) > 0 then ', заявки: ' || concat_ws(', ',
                case when r.s > 0 then 'сервис ' || r.s end, case when r.p > 0 then 'запчасти ' || r.p end,
                case when r.e > 0 then 'оборудование ' || r.e end) else '' end,
           E'\n' order by d.d)
    from d left join v on v.d = d.d left join r on r.d = d.d
   where coalesce(v.n, 0) + coalesce(r.s + r.p + r.e, 0) > 0
$$;
revoke execute on function app.weekly_report_days(uuid, date, date) from public, anon;

create or replace function app.weekly_report_text(p_from date, p_to date)
returns text language plpgsql stable as $$
declare
  x record;
  t record;
  msg text;
  url text := nullif(btrim((select value->>'crm_url' from public.app_settings where key = 'daily_report')), '');
  line text;
begin
  select coalesce(sum(done), 0) done, coalesce(sum(found_pts), 0) found_pts,
         coalesce(sum(i_high), 0) i_high, coalesce(sum(i_medium), 0) i_medium,
         coalesce(sum(r_service), 0) r_service, coalesce(sum(r_parts), 0) r_parts,
         coalesce(sum(r_equipment), 0) r_equipment, coalesce(sum(r_sum), 0) r_sum, count(*) reps
    into t from app.weekly_report_rows(p_from, p_to);
  if t.reps = 0 then return null; end if;

  msg := '[B]Отчёт торговых представителей за неделю ' || to_char(p_from, 'DD.MM') || '–' || to_char(p_to, 'DD.MM.YYYY') || '[/B]';

  for x in select * from app.weekly_report_rows(p_from, p_to) loop
    msg := msg || E'\n\n[B]' || x.full_name || '[/B]' || coalesce(E'\n' || app.weekly_report_days(x.manager_id, p_from, p_to), '');
    if x.done > 0 then
      msg := msg || E'\nПосещено точек: ' || x.done
        || ' за ' || x.work_days || ' ' || case when x.work_days = 1 then 'день' when x.work_days between 2 and 4 then 'дня' else 'дней' end
        || ' (в среднем ' || round(x.done::numeric / greatest(x.work_days, 1), 1)::text || ' в день)';
      if x.found_pts > 0 then msg := msg || E'\nНовые точки, добавленные на месте: ' || x.found_pts; end if;
      line := concat_ws(', ',
        case when x.i_high > 0 then 'высокий ' || x.i_high end,
        case when x.i_medium > 0 then 'средний ' || x.i_medium end,
        case when x.i_low > 0 then 'низкий ' || x.i_low end,
        case when x.i_none > 0 then 'нет ' || x.i_none end);
      if line <> '' then msg := msg || E'\nИнтерес: ' || line; end if;
      line := concat_ws(', ',
        case when x.seg_a > 0 then 'A — ' || x.seg_a end,
        case when x.seg_b > 0 then 'B — ' || x.seg_b end,
        case when x.seg_c > 0 then 'C — ' || x.seg_c end);
      if line <> '' then msg := msg || E'\nСегменты: ' || line; end if;
    end if;
    line := concat_ws(', ',
      case when x.r_service > 0 then 'сервис ' || x.r_service end,
      case when x.r_parts > 0 then 'запчасти ' || x.r_parts end,
      case when x.r_equipment > 0 then 'покупка оборудования ' || x.r_equipment end);
    if line <> '' then
      msg := msg || E'\nЗаявки: ' || line || case when x.r_sum > 0 then ' — на ' || app.fmt_money(x.r_sum) else '' end;
    end if;
  end loop;

  msg := msg || E'\n\n[B]Итого[/B]: посещено ' || t.done || ' '
    || case when t.done % 10 = 1 and t.done % 100 <> 11 then 'точка'
            when t.done % 10 between 2 and 4 and t.done % 100 not between 12 and 14 then 'точки' else 'точек' end
    || case when t.found_pts > 0 then ', из них новых на месте ' || t.found_pts else '' end
    || case when t.i_high + t.i_medium > 0 then E'\nИнтерес высокий/средний: ' || (t.i_high + t.i_medium) else '' end
    || case when t.r_service + t.r_parts + t.r_equipment > 0 then
         E'\nЗаявок: ' || (t.r_service + t.r_parts + t.r_equipment) || ' ('
         || concat_ws(', ', case when t.r_service > 0 then 'сервис ' || t.r_service end,
                            case when t.r_parts > 0 then 'запчасти ' || t.r_parts end,
                            case when t.r_equipment > 0 then 'покупка оборудования ' || t.r_equipment end) || ')'
         || case when t.r_sum > 0 then ' — на ' || app.fmt_money(t.r_sum) else '' end
       else E'\nЗаявок: нет' end
    || case when url is not null then E'\n\nПодробно в CRM: ' || rtrim(url, '/') || '/team' else '' end;
  return msg;
end $$;

create or replace function public.weekly_report_preview(p_from date default null, p_to date default null)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_to date := coalesce(p_to, app.local_date(now()));
begin
  if not app.is_service_call() and not app.has_perm('view_team') then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  return app.weekly_report_text(coalesce(p_from, v_to - (extract(isodow from v_to)::int - 1)), v_to);
end $$;
revoke execute on function public.weekly_report_preview(date, date) from public, anon;
grant execute on function public.weekly_report_preview(date, date) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.weekly_report_preview(date, date) to service_role';
  end if;
end $$;
